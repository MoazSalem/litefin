# Localization

Litefin supports full multi-language localization through flat JSON locale files. The **Translation Manager** resolves keys at runtime, supports interpolation placeholders (`{0}`, `{1}`, …), and handles Right-to-Left (RTL) layout switching automatically.

## File Structure

All locale files live in `src/locales/` and follow a flat key/value format:

```
src/locales/
├── en-us.json   ← source of truth
├── uk.json
├── pt-br.json
└── ...
```

File names map directly to language codes (e.g. `pt-br.json` for Brazilian Portuguese). Adding a new language is as simple as creating a new `.json` file and registering it in `src/locales/languages.js`.

### Key Conventions

- **Keys** are PascalCase and describe the UI element or context (e.g. `ButtonSignIn`, `HeaderCastAndCrew`, `LabelAudioCodec`).
- **Interpolation** uses positional placeholders: `"BirthDateValue": "Born: {0}"`.
- **Section comments** use a leading underscore key with an empty value to group entries: `"_Litefin Specific Keys": ""`. These are ignored by all tooling.

## Contributing a Translation

1. Copy `src/locales/en-us.json` to a new file named after the language code (e.g. `de.json`).
2. Translate each value. Do **not** rename or remove keys.
3. Preserve all `{0}`, `{1}` placeholders exactly as they appear.
4. Register the new locale in `src/locales/languages.js`.
5. Run the locale check tool (see below) to verify the file is complete before submitting.

## Locale Check Tool

The `check-locale` script helps translators and maintainers quickly identify gaps between `en-us.json` and any other locale. It reports three categories of issues:

| Category         | Description                                                                      |
| :--------------- | :------------------------------------------------------------------------------- |
| **Missing**      | Keys present in `en-us.json` but absent from the target file                     |
| **Untranslated** | Values identical to the English source — likely not yet translated               |
| **Extra**        | Keys present in the target file but not in `en-us.json` — may be stale or typo'd |

### Usage

```sh
# Check a single locale by code (positional)
npm run locale:check -- uk

# Explicit flag
npm run locale:check -- --locale uk

# Short flag
npm run locale:check -- -l pt-br

# Check by explicit path
npm run locale:check -- --locale src/locales/de.json

# Check every locale at once
npm run locale:check -- --all

# Stacked short flags: skip-short + no-extra
npm run locale:check -- uk -se
```

### Options

| Flag                      | Description                                                                                                                                       |
| :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--locale`, `-l <code>`   | Locale code or `.json` path to compare against `en-us.json`                                                                                       |
| `--all`, `-a`             | Scan every file in `src/locales/` except `en-us.json`                                                                                             |
| `--skip-short`, `-s`      | Only flag multi-word untranslated values — skips single-word matches like `"Audio"` or `"Codec"` that may legitimately share the English spelling |
| `--no-untranslated`, `-u` | Skip the untranslated-value check entirely                                                                                                        |
| `--no-extra`, `-e`        | Skip the extra-keys check                                                                                                                         |

Boolean short flags (`-s`, `-u`, `-e`, `-a`) can be stacked in a single token. When stacking with `-l` (which takes a value), put `-l` last:

```sh
node scripts/check-locale.js uk -se      # --skip-short + --no-extra
node scripts/check-locale.js uk -ue      # --no-untranslated + --no-extra
node scripts/check-locale.js -ul uk      # --no-untranslated + --locale uk
```

### Example Output

```
Locale Check
Source of truth: src/locales/en-us.json

── uk ─────────────────────────────────────────
  Source keys: 312  |  Coverage estimate: 97%  |  Issues: 8

  Missing keys (3):
  These keys exist in en-us.json but are absent from the target file.
    - SyncPlayAlreadyInGroupDesc
    - TrailerAutoChain
    - TrailerAutoChainDescription

  Untranslated keys (5):
  Values identical to the English source — likely not yet translated.
    - OsdFocusRestoreModeDescription  →  "Where the remote focus lands when the player controls reappear after being auto-hidden."
    - ...
```

The script exits with code `1` if any issues are found, making it suitable for use in CI pipelines.
