import zlib from 'node:zlib';
import fs from 'node:fs';
const f = process.argv[2];
const buf = fs.readFileSync(f);
const pos = [];
for (let i=0;i+4<=buf.length;i++) if (buf[i]===0x28&&buf[i+1]===0xb5&&buf[i+2]===0x2f&&buf[i+3]===0xfd) pos.push(i);
console.log('magic positions count', pos.length, 'first5', pos.slice(0,5));
if (pos.length>=2){
  const one = buf.subarray(pos[0], pos[1]);
  const two = buf.subarray(pos[0], pos[2] || buf.length);
  const withTrail = buf.subarray(pos[0], pos[1]+7);
  for (const [name,b] of [['one',one],['two',two],['withTrail',withTrail]]){
    try { const d = zlib.zstdDecompressSync(b); console.log(name,'OK bytes',d.length,'head',JSON.stringify(d.toString('utf8').slice(0,60))); }
    catch(e){ console.log(name,'FAIL',e.message); }
  }
}