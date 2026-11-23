import {readFile,writeFile} from 'node:fs/promises';
import wawoff2 from 'wawoff2';
const fonts=await Promise.all(['latin','cyrillic'].map(async subset=>Buffer.from(await wawoff2.decompress(await readFile(new URL(`../node_modules/@fontsource/roboto/files/roboto-${subset}-700-normal.woff2`,import.meta.url)))).toString('base64')));
await writeFile(new URL('../src/card-fonts.js',import.meta.url),'// Generated Roboto 700 subsets, SIL OFL 1.1; source: @fontsource/roboto.\nexport const CARD_FONTS = '+JSON.stringify(fonts)+';\n');
