import { parseScan } from './src/index.ts';
for (const s of ['BIN-0001','BIN-A09Z-0001','https://labels.example.org/l/BIN-A09Z-0001','0899441002823','329559']) console.log(s, JSON.stringify(parseScan(s, s.length===13?'ean_13':'qr_code')));
