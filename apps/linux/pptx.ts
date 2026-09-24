import type { Database } from 'bun:sqlite';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const xml = (s: unknown) => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relHead = `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
const coordinate = (n: number, scale: number) => Math.round((Number(n) || 0) * scale);
async function run(args: string[], cwd?: string) {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${args[0]} falló: ${stderr.trim()}`);
}
function shape(item: any, shapeId: number, rel: number): string {
  const x=coordinate(item.x,6350),y=coordinate(item.y,6350),cx=coordinate(item.width,6350),cy=coordinate(item.height,6350);
  const frame = `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
  if (item.type === 'text') {
    const color = /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color.slice(1) : '17211B';
    const align = ({left:'l',center:'ctr',right:'r'} as any)[item.align] || 'l';
    const font = Math.max(12, Math.min(240, Number(item.fontSize)||64))*100;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="Texto ${shapeId}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${frame}<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="es-ES" sz="${font}" b="${item.fontWeight >= 700 ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${xml(item.fontFamily || 'Arial')}"/></a:rPr><a:t>${xml(item.text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  }
  if (item.type === 'image') return `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId}" name="Imagen ${shapeId}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId${rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${frame}</p:spPr></p:pic>`;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId}" name="Video ${shapeId}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rId${rel+1}"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId${rel+2}"/></p:ext></p:extLst></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId${rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${frame}</p:spPr></p:pic>`;
}

export async function exportPptx(doc: any, db: Database, root: string, target: string) {
  if (!Array.isArray(doc.slides) || !doc.slides.length) throw new Error('La presentación no tiene diapositivas.');
  const temp = await mkdtemp(join(tmpdir(), 'pm-pptx-'));
  try {
    await run(['unzip','-q',resolve(import.meta.dir,'../local/template.pptx'),'-d',temp]);
    await rm(join(temp,'ppt/slides'), { recursive:true, force:true });
    await mkdir(join(temp,'ppt/slides/_rels'), { recursive:true });
    await mkdir(join(temp,'ppt/media'), { recursive:true });
    let mediaIndex = 0;
    for (const [slideIndex, slide] of doc.slides.entries()) {
      if (!Array.isArray(slide.elements)) throw new Error('Una diapositiva es inválida.');
      const shapes: string[] = [], rels: string[] = [];
      let rel = 1, shapeId = 2;
      for (const item of slide.elements) {
        if (!['text','image','video'].includes(item.type)) throw new Error('Elemento no admitido en la diapositiva.');
        if (item.type === 'image') {
          const name = String(item.assetId || '');
          if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g)$/.test(name)) throw new Error('Imagen inválida.');
          const src = join(root,'assets',name);
          if (!existsSync(src)) throw new Error('Falta una imagen.');
          const mediaName = `image${++mediaIndex}${extname(name)}`;
          await cp(src,join(temp,'ppt/media',mediaName));
          rels.push(`<Relationship Id="rId${rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>`);
        }
        if (item.type === 'video') {
          const youtubeId = String(item.youtubeId || '');
          if (!/^[a-zA-Z0-9_-]{6,20}$/.test(youtubeId)) throw new Error('ID de video inválido.');
          const media: any = db.query('SELECT * FROM media WHERE youtube_id=?').get(youtubeId);
          if (!media?.path || !existsSync(media.path)) throw new Error(`Falta el video ${xml(item.title || youtubeId)}.`);
          const videoName=`video${++mediaIndex}.mp4`, posterName=`poster${mediaIndex}.jpg`;
          await cp(media.path,join(temp,'ppt/media',videoName));
          if (!media.poster || !existsSync(media.poster)) {
            await run(['ffmpeg','-y','-ss','0','-i',media.path,'-frames:v','1','-q:v','3',join(temp,'ppt/media',posterName)]);
          } else await cp(media.poster,join(temp,'ppt/media',posterName));
          rels.push(`<Relationship Id="rId${rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${posterName}"/>`,`<Relationship Id="rId${rel+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/${videoName}"/>`,`<Relationship Id="rId${rel+2}" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/${videoName}"/>`);
        }
        shapes.push(shape(item,shapeId++,rel));
        if (item.type==='image') rel++; else if(item.type==='video') rel+=3;
      }
      rels.push(`<Relationship Id="rId${rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`);
      const sld=`${head}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
      await writeFile(join(temp,`ppt/slides/slide${slideIndex+1}.xml`),sld);
      await writeFile(join(temp,`ppt/slides/_rels/slide${slideIndex+1}.xml.rels`),relHead+rels.join('')+'</Relationships>');
    }
    const count=doc.slides.length;
    const types=`${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="mp4" ContentType="video/mp4"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${doc.slides.map((_:any,i:number)=>`<Override PartName="/ppt/slides/slide${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`;
    await writeFile(join(temp,'[Content_Types].xml'),types);
    await writeFile(join(temp,'ppt/presentation.xml'),`${head}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${doc.slides.map((_:any,i:number)=>`<p:sldId id="${256+i}" r:id="rId${i+2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`);
    await writeFile(join(temp,'ppt/_rels/presentation.xml.rels'),relHead+`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`+doc.slides.map((_:any,i:number)=>`<Relationship Id="rId${i+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i+1}.xml"/>`).join('')+`<Relationship Id="rId${count+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId${count+3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId${count+4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/><Relationship Id="rId${count+5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`);
    await writeFile(join(temp,'docProps/app.xml'),`${head}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Presentation Maker</Application><Slides>${count}</Slides></Properties>`);
    await writeFile(join(temp,'docProps/core.xml'),`${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(doc.title)}</dc:title><dc:creator>Presentation Maker</dc:creator></cp:coreProperties>`);
    await rm(target,{force:true});
    await run(['zip','-qr',target,'.'],temp);
    await run(['unzip','-tq',target]);
  } finally { await rm(temp,{recursive:true,force:true}); }
}
