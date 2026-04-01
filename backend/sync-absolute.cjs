const fs = require('fs');
const path = require('path');

const SEQUENCES_FILE = 'C:\\Autobuses\\backend\\data\\processed\\official-sequences.json';
const ALIAS_MAP_FILE = 'C:\\Autobuses\\backend\\data\\processed\\alias-map.json';
const METADATA_FILE = 'C:\\Autobuses\\backend\\data\\processed\\vitrasa-stops-metadata.json';

const officialSequences = {
  "10": {
    "ida": ["7870","2340","2350","2370","2310","650","600","3090","310","280","290","3780","3770","3740","3810","3790","14362","2190","2180","2170","2140","2160","14171","2150","990","1000","980","1050","14268","1030","14131","8440","8420","1320","1310","20075","1280","20076","1260","14901","6940"],
    "vuelta": ["8160","1001","1430","11520","1380","1390","1400","1410","1420","1490"]
  }
};

const aliasMap = {
  "1001": "20198"
};

const metadata = {
  "1001": { "id": "1001", "name": "Rúa de Policarpo Sanz, 15", "lat": 42.237533428168, "lon": -8.725195046293 }
};

try {
  fs.writeFileSync(SEQUENCES_FILE, JSON.stringify(officialSequences, null, 2));
  fs.writeFileSync(ALIAS_MAP_FILE, JSON.stringify(aliasMap, null, 2));
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  console.log("SUCCESS: Files written to absolute paths.");
} catch (e) {
  console.error("ERROR:", e.message);
}
