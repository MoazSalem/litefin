const fs = require('fs');
const path = require('path');
const localesPath = 'src/locales';

const enUs = JSON.parse(fs.readFileSync(path.join(localesPath, 'en-us.json'), 'utf8'));
const enUsOrder = Object.keys(enUs);

const translations = {
    ar: {
        LabelShowRandomButton: "زر الاختيار العشوائي",
        Random: "عشوائي",
        ShowRandomButtonDescription: "إظهار زر في الشريط الجانبي لفتح فيلم أو مسلسل عشوائي."
    },
    bn: {
        LabelShowRandomButton: "এলোমেলো বাটন",
        Random: "এলোমেলো",
        ShowRandomButtonDescription: "একটি রানডম মুভি বা শো খোলার জন্য সাইডবারে একটি বাটন দেখান।"
    },
    de: {
        LabelShowRandomButton: "Zufalls-Button",
        Random: "Zufällig",
        ShowRandomButtonDescription: "Zeigt eine Schaltfläche in der Seitenleiste an, um einen zufälligen Film oder eine Serie zu öffnen."
    },
    es: {
        LabelShowRandomButton: "Botón Aleatorio",
        Random: "Aleatorio",
        ShowRandomButtonDescription: "Muestra un botón en la barra lateral para abrir una película o serie aleatoria."
    },
    fr: {
        LabelShowRandomButton: "Bouton Aléatoire",
        Random: "Aléatoire",
        ShowRandomButtonDescription: "Affiche un bouton dans la barre latérale pour ouvrir un film ou une série au hasard."
    },
    "hi-in": {
        LabelShowRandomButton: "रैंडम बटन",
        Random: "रैंडम",
        ShowRandomButtonDescription: "रैंडम मूवी या शो खोलने के लिए साइडबार में एक बटन दिखाएं।"
    },
    hr: {
        LabelShowRandomButton: "Nasumični gumb",
        Random: "Nasumično",
        ShowRandomButtonDescription: "Prikazuje gumb na bočnoj traci za otvaranje nasumičnog filma ili serije."
    },
    it: {
        LabelShowRandomButton: "Pulsante Casuale",
        Random: "Casuale",
        ShowRandomButtonDescription: "Mostra un pulsante nella barra laterale per aprire un film o una serie casuale."
    },
    ja: {
        LabelShowRandomButton: "ランダムボタン",
        Random: "ランダム",
        ShowRandomButtonDescription: "サイドバーにランダムな映画や番組を開くためのボタンを表示します。"
    },
    ko: {
        LabelShowRandomButton: "무작위 버튼",
        Random: "무작위",
        ShowRandomButtonDescription: "사이드바에 무작위 영화나 프로그램을 열 수 있는 버튼을 표시합니다."
    },
    nl: {
        LabelShowRandomButton: "Willekeurige knop",
        Random: "Willekeurig",
        ShowRandomButtonDescription: "Toon een knop in de zijbalk om een willekeurige film of serie te openen."
    },
    pl: {
        LabelShowRandomButton: "Przycisk Losuj",
        Random: "Losowo",
        ShowRandomButtonDescription: "Wyświetla przycisk na pasku bocznym do otwierania losowego filmu lub serialu."
    },
    "pt-br": {
        LabelShowRandomButton: "Botão Aleatório",
        Random: "Aleatorio",
        ShowRandomButtonDescription: "Mostra um botón na barra lateral para abrir uma película ou série aleatória."
    },
    ru: {
        LabelShowRandomButton: "Кнопка 'Случайно'",
        Random: "Случайно",
        ShowRandomButtonDescription: "Отображать кнопку в боковой панели для открытия случайного фильма или сериала."
    },
    sr: {
        LabelShowRandomButton: "Nasumično dugme",
        Random: "Nasumično",
        ShowRandomButtonDescription: "Prikazuje dugme na bočnoj traci za otvaranje nasumičnog filma ili serije."
    },
    sv: {
        LabelShowRandomButton: "Slumpa-knapp",
        Random: "Slumpa",
        ShowRandomButtonDescription: "Visa en knapp i sidofältet för att öppna en slumpmässig film eller serie."
    },
    tr: {
        LabelShowRandomButton: "Rastgele Butonu",
        Random: "Rastgele",
        ShowRandomButtonDescription: "Kenar çubuğunda rastgele bir film veya dizi açmak için bir buton gösterir."
    },
    vi: {
        LabelShowRandomButton: "Nút Ngẫu nhiên",
        Random: "Ngẫu nhiên",
        ShowRandomButtonDescription: "Hiển thị nút trong thanh bên để mở phim hoặc chương trình ngẫu nhiên."
    },
    "zh-cn": {
        LabelShowRandomButton: "随机按钮",
        Random: "随机",
        ShowRandomButtonDescription: "在侧边栏显示一个按钮，用于打开随机电影或剧集。"
    }
};

Object.keys(translations).forEach(locale => {
    const p = path.join(localesPath, locale + '.json');
    if (!fs.existsSync(p)) return;
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    
    // Inject translations
    Object.assign(json, translations[locale]);
    
    // Reorder based on en-us
    const reordered = {};
    enUsOrder.forEach(key => {
        if (json.hasOwnProperty(key)) {
            reordered[key] = json[key];
        } else {
            reordered[key] = enUs[key]; // Fill missing with English
        }
    });
    
    fs.writeFileSync(p, JSON.stringify(reordered, null, 4) + '\n');
    console.log(`Updated and synchronized locale: ${locale}`);
});
