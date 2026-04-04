const fs = require('fs');
const path = require('path');
const localesPath = 'src/locales';
const enUsPath = path.join(localesPath, 'en-us.json');
const enUs = JSON.parse(fs.readFileSync(enUsPath, 'utf8'));
const enUsOrder = Object.keys(enUs);

const trans = {
    ar: { ConfirmAppExitDescription: 'إظهار مطالبة تأكيد قبل إغلاق التطبيق.', ConfirmAppExitLabel: 'التأكيد عند الخروج', ConfirmAppExitMessage: 'هل أنت متأكد أنك تريد الخروج من Litefin؟', ConfirmAppExitTitle: 'إغلاق التطبيق؟' },
    bn: { ConfirmAppExitDescription: 'অ্যাপ্লিকেশন বন্ধ করার আগে একটি নিশ্চিতকরণ প্রম্পট দেখান।', ConfirmAppExitLabel: 'প্রস্থানে নিশ্চিত করুন', ConfirmAppExitMessage: 'আপনি কি নিশ্চিত যে আপনি Litefin থেকে প্রস্থান করতে চান?', ConfirmAppExitTitle: 'অ্যাপ্লিকেশন থেকে প্রস্থান করবেন?' },
    de: { ConfirmAppExitDescription: 'Bestätigungsaufforderung vor dem Schließen der App anzeigen.', ConfirmAppExitLabel: 'Beim Beenden bestätigen', ConfirmAppExitMessage: 'Sind Sie sicher, dass Sie Litefin verlassen möchten?', ConfirmAppExitTitle: 'App beenden?' },
    es: { ConfirmAppExitDescription: 'Mostrar un mensaje de confirmación antes de cerrar la aplicación.', ConfirmAppExitLabel: 'Confirmar al salir', ConfirmAppExitMessage: '¿Estás seguro de que quieres salir de Litefin?', ConfirmAppExitTitle: '¿Cerrar aplicación?' },
    fr: { ConfirmAppExitDescription: 'Afficher un message de confirmation avant de fermer l\'application.', ConfirmAppExitLabel: 'Confirmer à la fermeture', ConfirmAppExitMessage: 'Êtes-vouz sûr de vouloir quitter Litefin ?', ConfirmAppExitTitle: 'Quitter l\'application ?' },
    "hi-in": { ConfirmAppExitDescription: 'एप्लिकेशन बंद करने से पहले एक पुष्टि संकेत दिखाएं।', ConfirmAppExitLabel: 'निकास पर पुष्टि करें', ConfirmAppExitMessage: 'क्या आप वाकई Litefin से बाहर निकलना चाहते हैं?', ConfirmAppExitTitle: 'एप्लिकेशन बंद करें?' },
    hr: { ConfirmAppExitDescription: 'Prikaži upit za potvrdu prije zatvaranja aplikacije.', ConfirmAppExitLabel: 'Potvrdi pri izlasku', ConfirmAppExitMessage: 'Jeste li sigurni da želite izaći iz Litefin-a?', ConfirmAppExitTitle: 'Izaći iz aplikacije?' },
    it: { ConfirmAppExitDescription: 'Mostra un messaggio di conferma prima di chiudere l\'applicazione.', ConfirmAppExitLabel: 'Conferma all\'uscita', ConfirmAppExitMessage: 'Sei sicuro di voler uscire da Litefin?', ConfirmAppExitTitle: 'Esci dall\'applicazione?' },
    ko: { ConfirmAppExitDescription: '애플리케이션을 닫기 전에 확인 프롬프트를 표시합니다.', ConfirmAppExitLabel: '종료 시 확인', ConfirmAppExitMessage: 'Litefin을 종료하시겠습니까?', ConfirmAppExitTitle: '애플리케이션 종료?' },
    nl: { ConfirmAppExitDescription: 'Toon een bevestigingsvenster voor het sluiten van de applicatie.', ConfirmAppExitLabel: 'Bevestigen bij afsluiten', ConfirmAppExitMessage: 'Weet je zeker dat je Litefin wilt afsluiten?', ConfirmAppExitTitle: 'Applicatie afsluiten?' },
    pl: { ConfirmAppExitDescription: 'Pokaż monit potwierdzający przed zamknięciem aplikacji.', ConfirmAppExitLabel: 'Potwierdź przy wyjściu', ConfirmAppExitMessage: 'Czy na pewno chcesz opuścić Litefin?', ConfirmAppExitTitle: 'Zamknąć aplikację?' },
    "pt-br": { ConfirmAppExitDescription: 'Mostrar um prompt de confirmação antes de fechar o aplicativo.', ConfirmAppExitLabel: 'Confirmar ao sair', ConfirmAppExitMessage: 'Tem certeza de que deseja sair do Litefin?', ConfirmAppExitTitle: 'Sair do aplicativo?' },
    ru: { ConfirmAppExitDescription: 'Показывать подтверждение перед закрытием приложения.', ConfirmAppExitLabel: 'Подтверждение при выходе', ConfirmAppExitMessage: 'Вы уверены, что хотите выйти из Litefin?', ConfirmAppExitTitle: 'Выйти из приложения?' },
    sv: { ConfirmAppExitDescription: 'Visa en bekräftelse innan programmet stängs.', ConfirmAppExitLabel: 'Bekräfta vid avslut', ConfirmAppExitMessage: 'Är du säker på att du vill avsluta Litefin?', ConfirmAppExitTitle: 'Avsluta applikationen?' },
    tr: { ConfirmAppExitDescription: 'Uygulamayı kapatmadan önce bir onay istemi göster.', ConfirmAppExitLabel: 'Çıkışta onayla', ConfirmAppExitMessage: 'Litefin\'den çıkmak istediğinizden emin misiniz?', ConfirmAppExitTitle: 'Uygulamadan çıkılsın mı?' },
    vi: { ConfirmAppExitDescription: 'Hiển thị lời nhắc xác nhận trước khi đóng ứng dụng.', ConfirmAppExitLabel: 'Xác nhận khi thoát', ConfirmAppExitMessage: 'Bạn có chắc chắn muốn thoát Litefin không?', ConfirmAppExitTitle: 'Thoát ứng dụng?' },
    "zh-cn": { ConfirmAppExitDescription: '关闭应用程序前显示确认提示。', ConfirmAppExitLabel: '退出时确认', ConfirmAppExitMessage: '您确定要退出 Litefin 吗？', ConfirmAppExitTitle: '退出应用程序？' },
    sr: { ConfirmAppExitDescription: 'Prikaži prompt za potvrdu pre zatvaranja aplikacije.', ConfirmAppExitLabel: 'Potvrda pri izlasku', ConfirmAppExitMessage: 'Da li ste sigurni da želite da napustite Litefin?', ConfirmAppExitTitle: 'Napustiti aplikaciju?' },
    ja: { ConfirmAppExitDescription: 'アプリを終了する前に確認プロンプトを表示します。', ConfirmAppExitLabel: '終了時に確認', ConfirmAppExitMessage: 'Litefinを終了してもよろしいですか？', ConfirmAppExitTitle: 'アプリを終了しますか？' }
};

Object.keys(trans).forEach(locale => {
    const p = path.join(localesPath, locale + '.json');
    if (!fs.existsSync(p)) return;
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    Object.assign(json, trans[locale]);
    const reordered = {};
    enUsOrder.forEach(k => {
        if (json.hasOwnProperty(k)) reordered[k] = json[k];
    });
    fs.writeFileSync(p, JSON.stringify(reordered, null, 4) + '\n');
    console.log(`Updated ${locale}`);
});
