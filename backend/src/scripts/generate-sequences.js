const fs = require('fs');
const path = require('path');

const INPUT_PATH = path.join(__dirname, '../data/processed/stop-lines-index.json');
const OUTPUT_PATH = path.join(__dirname, '../data/processed/official-sequences.json');

console.log('--- Inyectando Todas las Líneas de Vigo ---');

try {
    const raw = fs.readFileSync(INPUT_PATH, 'utf8');
    const data = JSON.parse(raw);
    
    // El índice tiene 'byLineDirection' con claves como '10:ida'
    const byLineDir = data.byLineDirection || {};
    const result = {};

    Object.keys(byLineDir).forEach(key => {
        const [lineId, dir] = key.split(':');
        const entries = byLineDir[key];

        if (!lineId || !dir || !entries) return;

        if (!result[lineId]) {
            result[lineId] = { ida: [], vuelta: [] };
        }

        // Ya vienen ordenados en el índice por sequence (según stop-lines.ts)
        result[lineId][dir] = entries.map(e => e.stopId);
    });

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
    console.log(`EXITO: Se inyectaron ${Object.keys(result).length} líneas.`);

} catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
}
