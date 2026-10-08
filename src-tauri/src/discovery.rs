// =============================================================================
// Litefin - Native Jellyfin Server UDP Discovery & Wake-on-LAN Subsystem
// =============================================================================
// Provides zero-overhead, ultra-fast server auto-discovery across local networks
// directly via Rust standard library UDP sockets (std::net::UdpSocket).
//
// Supports:
//  - Windows, macOS, Linux (Tauri desktop targets)
//  - Android TV & Amazon Fire TV (Tauri mobile/embedded targets)
//
// Multi-Network Interface Routing Resolution:
//  - On Windows, sending to 255.255.255.255 from an unbound socket only leaves
//    through a single interface selected by default metric (which is often a
//    virtual adapter such as WSL or VirtualBox).
//  - To guarantee detection of all LAN servers (e.g. 192.168.1.62), we query
//    the Windows IP address table to compute directed subnet broadcast targets
//    (e.g. 192.168.1.255), and also accept optional direct unicast hints.
// =============================================================================

use std::collections::HashSet;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tauri::Manager;

// -----------------------------------------------------------------------------
// Global Discovery Cancellation Token
// -----------------------------------------------------------------------------
// Allows instantaneous cancellation of an ongoing UDP discovery scan loop
// when the user logs in, cancels the dialog, or navigates away.
// -----------------------------------------------------------------------------
static DISCOVERY_CANCELLED: AtomicBool = AtomicBool::new(false);

// -----------------------------------------------------------------------------
// Jellyfin Discovery Protocol Constants
// -----------------------------------------------------------------------------
const JELLYFIN_DISCOVERY_PORT: u16 = 7359;
const JELLYFIN_PROBE_MESSAGE: &[u8] = b"who is JellyfinServer?";
const DEFAULT_DISCOVERY_TIMEOUT_MS: u64 = 2500;
const SOCKET_POLL_INTERVAL_MS: u64 = 150;

// =============================================================================
// Platform-Specific Network Interface Enumeration
// =============================================================================

#[cfg(windows)]
mod net_interfaces {
    use std::net::Ipv4Addr;

    // Windows MIB_IPADDRROW structure from iphlpapi
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct MibIpAddrRow {
        dw_addr: u32,
        dw_index: u32,
        dw_mask: u32,
        dw_bcast_addr: u32,
        dw_reasm_size: u32,
        unused1: u16,
        w_type: u16,
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetIpAddrTable(
            p_ip_addr_table: *mut u8,
            pdw_size: *mut u32,
            b_order: i32,
        ) -> u32;
    }

    /// Queries all active IPv4 interfaces on Windows and computes their
    /// respective directed subnet broadcast addresses (e.g. 192.168.1.255).
    pub fn get_local_broadcast_addrs() -> Vec<Ipv4Addr> {
        let mut broadcast_addrs = Vec::new();
        let mut size = 0u32;

        unsafe {
            // First call retrieves the required buffer size
            let _ = GetIpAddrTable(std::ptr::null_mut(), &mut size, 0);
            if size == 0 {
                return broadcast_addrs;
            }

            let mut buffer = vec![0u8; size as usize];
            if GetIpAddrTable(buffer.as_mut_ptr(), &mut size, 0) == 0 {
                let num_entries = *(buffer.as_ptr() as *const u32) as usize;
                let rows_ptr = buffer.as_ptr().add(std::mem::size_of::<u32>()) as *const MibIpAddrRow;

                for i in 0..num_entries {
                    let row = *rows_ptr.add(i);

                    // dw_addr and dw_mask are stored in network byte order (big endian)
                    let ip_u32 = u32::from_be(row.dw_addr);
                    let mask_u32 = u32::from_be(row.dw_mask);

                    // Skip unassigned (0.0.0.0), loopback (127.x.x.x), and link-local (169.254.x.x)
                    if ip_u32 == 0 || (ip_u32 >> 24) == 127 || (ip_u32 >> 16) == 0xA9FE {
                        continue;
                    }

                    if mask_u32 != 0 {
                        // Directed broadcast formula: (IP & MASK) | (~MASK)
                        let bcast_u32 = (ip_u32 & mask_u32) | (!mask_u32);
                        let bcast_ip = Ipv4Addr::from(bcast_u32);

                        if !broadcast_addrs.contains(&bcast_ip) {
                            broadcast_addrs.push(bcast_ip);
                        }
                    }
                }
            }
        }

        broadcast_addrs
    }
}

#[cfg(not(windows))]
mod net_interfaces {
    use std::net::Ipv4Addr;

    /// On Unix / Android / macOS, standard 255.255.255.255 broadcast routes
    /// through the active primary network interface reliably.
    pub fn get_local_broadcast_addrs() -> Vec<Ipv4Addr> {
        Vec::new()
    }
}

// =============================================================================
// Data Transfer Objects
// =============================================================================

/// Public representation of a discovered server returned across the Tauri IPC bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub address: String,
    pub id: String,
    pub name: String,
}

/// Raw JSON payload structure sent back by the Jellyfin server's discovery daemon.
#[derive(Debug, Clone, Deserialize)]
struct RawDiscoveryPayload {
    #[serde(alias = "Address", alias = "address")]
    address: Option<String>,
    #[serde(alias = "Id", alias = "id")]
    id: Option<String>,
    #[serde(alias = "Name", alias = "name")]
    name: Option<String>,
}

// =============================================================================
// IPC Command: Cancel Server Discovery
// =============================================================================

/// Cancels any currently active discovery scan loop immediately.
#[tauri::command]
pub fn cancel_server_discovery() {
    DISCOVERY_CANCELLED.store(true, Ordering::Relaxed);
}

// =============================================================================
// IPC Command: Discover Servers
// =============================================================================

/// Broadcasts UDP discovery probes across all local networks and directs
/// probes to any provided hint targets, collecting responses from active
/// Jellyfin instances within the specified timeout.
#[tauri::command]
pub async fn discover_servers(
    app: tauri::AppHandle,
    timeout_ms: Option<u64>,
    target_hints: Option<Vec<String>>,
) -> Result<Vec<DiscoveredServer>, String> {
    // Reset cancellation state before initiating discovery
    DISCOVERY_CANCELLED.store(false, Ordering::Relaxed);

    let total_timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_DISCOVERY_TIMEOUT_MS));
    let hints = target_hints.unwrap_or_default();

    // Offload synchronous socket blocking I/O to the Tokio worker thread pool
    tauri::async_runtime::spawn_blocking(move || {
        perform_udp_discovery(&app, total_timeout, &hints)
    })
    .await
    .map_err(|join_err| format!("Discovery task execution error: {}", join_err))?
}

/// Extracts a raw IPv4 or hostname from a given URL or host string.
fn extract_host_from_hint(hint: &str) -> Option<String> {
    let trimmed = hint.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Strip http:// or https:// prefix if present
    let without_proto = if let Some(stripped) = trimmed.strip_prefix("https://") {
        stripped
    } else if let Some(stripped) = trimmed.strip_prefix("http://") {
        stripped
    } else {
        trimmed
    };

    // Strip path suffix
    let host_and_port = without_proto.split('/').next().unwrap_or(without_proto);

    // Strip port suffix
    let host = host_and_port.split(':').next().unwrap_or(host_and_port);

    if host.is_empty() || host == "localhost" || host == "127.0.0.1" {
        None
    } else {
        Some(host.to_string())
    }
}

/// Internal worker executing the UDP broadcast & unicast discovery loop.
fn perform_udp_discovery(
    app: &tauri::AppHandle,
    total_timeout: Duration,
    hints: &[String],
) -> Result<Vec<DiscoveredServer>, String> {
    // -------------------------------------------------------------------------
    // Socket Initialization & Configuration
    // -------------------------------------------------------------------------
    // Bind to any available ephemeral port on all local IPv4 network interfaces.
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("Failed to bind UDP discovery socket: {}", e))?;

    // Enable broadcast mode to allow transmission across subnet broadcast IPs
    socket
        .set_broadcast(true)
        .map_err(|e| format!("Failed to enable UDP socket broadcast: {}", e))?;

    // Set a short read timeout so the loop can check for cancellation frequently
    socket
        .set_read_timeout(Some(Duration::from_millis(SOCKET_POLL_INTERVAL_MS)))
        .map_err(|e| format!("Failed to configure UDP socket read timeout: {}", e))?;

    // -------------------------------------------------------------------------
    // Build Comprehensive List of Discovery Probe Destinations
    // -------------------------------------------------------------------------
    let mut target_destinations: Vec<String> = Vec::new();

    // 1. Universal broadcast target
    target_destinations.push(format!("255.255.255.255:{}", JELLYFIN_DISCOVERY_PORT));

    // 2. Local loopback destination
    target_destinations.push(format!("127.0.0.1:{}", JELLYFIN_DISCOVERY_PORT));

    // 3. Directed subnet broadcast targets for each active network interface
    // (Crucial on Windows when virtual adapters like WSL/VirtualBox hijack 255.255.255.255)
    for bcast_ip in net_interfaces::get_local_broadcast_addrs() {
        let endpoint = format!("{}:{}", bcast_ip, JELLYFIN_DISCOVERY_PORT);
        if !target_destinations.contains(&endpoint) {
            target_destinations.push(endpoint);
        }
    }

    // 4. Any direct hints passed from saved servers or manual configurations
    for hint in hints {
        if let Some(host) = extract_host_from_hint(hint) {
            let endpoint = format!("{}:{}", host, JELLYFIN_DISCOVERY_PORT);
            if !target_destinations.contains(&endpoint) {
                target_destinations.push(endpoint);
            }
        }
    }

    // Helper closure to dispatch probes across all resolved destinations
    let send_probes = |sock: &UdpSocket| {
        for target in &target_destinations {
            let _ = sock.send_to(JELLYFIN_PROBE_MESSAGE, target);
        }
    };

    // Initial broadcast dispatch
    send_probes(&socket);

    let start_time = Instant::now();
    let mut second_probe_dispatched = false;
    let mut discovered_servers: Vec<DiscoveredServer> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut seen_addresses: HashSet<String> = HashSet::new();
    let mut recv_buf = [0u8; 4096];

    // -------------------------------------------------------------------------
    // Receive & Parse Processing Loop
    // -------------------------------------------------------------------------
    while start_time.elapsed() < total_timeout {
        // Break promptly if cancelled by the user interface
        if DISCOVERY_CANCELLED.load(Ordering::Relaxed) {
            break;
        }

        // Send a second probe burst at ~250ms to mitigate packet loss over Wi-Fi
        if !second_probe_dispatched && start_time.elapsed() >= Duration::from_millis(250) {
            second_probe_dispatched = true;
            send_probes(&socket);
        }

        // Poll socket for incoming server response packets
        match socket.recv_from(&mut recv_buf) {
            Ok((bytes_read, remote_addr)) => {
                if bytes_read == 0 {
                    continue;
                }

                // Attempt to deserialize response payload from server
                if let Ok(raw_json) = std::str::from_utf8(&recv_buf[..bytes_read]) {
                    if let Ok(parsed) = serde_json::from_str::<RawDiscoveryPayload>(raw_json) {
                        let server_id = parsed.id.unwrap_or_default().trim().to_string();
                        let raw_address = parsed.address.unwrap_or_default().trim().to_string();
                        let server_name = parsed
                            .name
                            .filter(|n| !n.trim().is_empty())
                            .unwrap_or_else(|| "Jellyfin Server".to_string());

                        // Resolve server address, substituting 0.0.0.0 with packet origin IP
                        let resolved_address = sanitize_server_address(&raw_address, remote_addr);

                        if resolved_address.is_empty() {
                            continue;
                        }

                        // Deduplicate responses by server identifier or resolved address
                        let id_is_new = !server_id.is_empty() && seen_ids.insert(server_id.clone());
                        let addr_is_new = seen_addresses.insert(resolved_address.clone());

                        if id_is_new || addr_is_new {
                            let server = DiscoveredServer {
                                address: resolved_address,
                                id: server_id,
                                name: server_name,
                            };

                            // Dispatch real-time DOM notification directly into the webview window
                            emit_server_discovered_event(app, &server);

                            discovered_servers.push(server);
                        }
                    }
                }
            }
            Err(ref err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                // Normal poll timeout — cycle loop and inspect cancellation token
                continue;
            }
            Err(_) => {
                // Ignore unexpected transport hiccups and continue gathering packets
                continue;
            }
        }
    }

    Ok(discovered_servers)
}

/// Normalizes server addresses, substituting placeholder hosts (e.g. 0.0.0.0 or [::])
/// with the true physical IP address of the responding socket peer.
fn sanitize_server_address(raw_address: &str, remote_addr: SocketAddr) -> String {
    let peer_ip = remote_addr.ip().to_string();

    if raw_address.is_empty() {
        return format!("http://{}:8096", peer_ip);
    }

    // Replace 0.0.0.0 or wildcard IPv6 addresses with sender IP
    if raw_address.contains("0.0.0.0") {
        raw_address.replace("0.0.0.0", &peer_ip)
    } else if raw_address.contains("[::]") {
        raw_address.replace("[::]", &peer_ip)
    } else {
        raw_address.to_string()
    }
}

/// Notifies the frontend webview of a newly discovered server by evaluating
/// a CustomEvent dispatch directly on the browser window object.
fn emit_server_discovered_event(app: &tauri::AppHandle, server: &DiscoveredServer) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(payload_json) = serde_json::to_string(server) {
            let script = format!(
                "try {{ window.dispatchEvent(new CustomEvent('litefin:server-found', {{ detail: {} }})); }} catch (_) {{}}",
                payload_json
            );
            let _ = window.eval(&script);
        }
    }
}

// =============================================================================
// IPC Command: Send Wake-on-LAN Magic Packet
// =============================================================================

/// Dispatches a Wake-on-LAN Magic Packet targeting the provided MAC address.
/// Broadcasts to both global 255.255.255.255 and all active subnet broadcast IPs.
#[tauri::command]
pub fn send_wake_on_lan(mac_address: String) -> Result<bool, String> {
    // -------------------------------------------------------------------------
    // Parse & Sanitize Hardware MAC Address
    // -------------------------------------------------------------------------
    let hex_digits: String = mac_address
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();

    if hex_digits.len() != 12 {
        return Err(format!(
            "Invalid MAC address: must contain 12 hex digits (got '{}')",
            mac_address
        ));
    }

    // Convert each 2-character hex pair into a byte
    let mut mac_bytes = [0u8; 6];
    for (i, chunk) in hex_digits.as_bytes().chunks(2).enumerate() {
        let hex_str = std::str::from_utf8(chunk)
            .map_err(|e| format!("Failed to read hex chunk: {}", e))?;
        mac_bytes[i] = u8::from_str_radix(hex_str, 16)
            .map_err(|e| format!("Invalid hex digit pair in MAC '{}': {}", hex_str, e))?;
    }

    // -------------------------------------------------------------------------
    // Construct 102-Byte Magic Packet Frame
    // -------------------------------------------------------------------------
    let mut packet = [0u8; 102];

    // Leading 6-byte sync header (all 0xFF)
    packet[..6].fill(0xFF);

    // Followed by 16 copies of the target 6-byte MAC address
    for i in 0..16 {
        let offset = 6 + (i * 6);
        packet[offset..offset + 6].copy_from_slice(&mac_bytes);
    }

    // -------------------------------------------------------------------------
    // Broadcast Dispatch via UDP Sockets
    // -------------------------------------------------------------------------
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("Failed to bind UDP socket for WOL: {}", e))?;

    socket
        .set_broadcast(true)
        .map_err(|e| format!("Failed to enable UDP broadcast for WOL: {}", e))?;

    // Broadcast magic packet across global ports 9 and 7
    let _ = socket.send_to(&packet, "255.255.255.255:9");
    let _ = socket.send_to(&packet, "255.255.255.255:7");

    // Also broadcast across all local subnet broadcast addresses
    for bcast_ip in net_interfaces::get_local_broadcast_addrs() {
        let _ = socket.send_to(&packet, format!("{}:9", bcast_ip));
        let _ = socket.send_to(&packet, format!("{}:7", bcast_ip));
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_broadcast_addresses_detected() {
        let addrs = net_interfaces::get_local_broadcast_addrs();
        println!("Detected broadcast addresses: {:?}", addrs);
        #[cfg(windows)]
        assert!(!addrs.is_empty(), "Should detect at least one active broadcast address on Windows");
    }
}
