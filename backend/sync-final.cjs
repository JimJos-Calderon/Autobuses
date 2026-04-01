const fs = require('fs');
const path = require('path');

const officialSequences = {
  "10": {
    "ida": ["7870","2340","2350","2370","2310","650","600","3090","310","280","290","3780","3770","3740","3810","3790","14362","2190","2180","2170","2140","2160","14171","2150","990","1000","980","1050","14268","1030","14131","8440","8420","1320","1310","20075","1280","20076","1260","14901","6940"],
    "vuelta": ["8160","1001","1430","11520","1380","1390","1400","1410","1420","1490"]
  }
};

const processedDir = path.join(__dirname, 'data', 'processed');
if (!fs.existsSync(processedDir)) {
  fs.mkdirSync(processedDir, { recursive: true });
}

fs.writeFileSync(path.join(processedDir, 'official-sequences.json'), JSON.stringify(officialSequences, null, 2));

// Forzar Alias Map manual para Policarpo Sanz (1001 -> 20198)
const aliasMap = {
  "1001": "20198"
};
fs.writeFileSync(path.join(processedDir, 'alias-map.json'), JSON.stringify(aliasMap, null, 2));

console.log("¡SINCRONIZACIÓN FORZADA COMPLETADA! Archivos escritos en:", processedDir);
