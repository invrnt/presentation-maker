import { expect, test } from 'bun:test';
import { validateDocument } from './document.ts';
const video = (id: string, x=160, width=1600) => ({id,type:'video',youtubeId:'video123456',x,y:90,width,height:900});
const doc = (elements: any[]) => ({version:1,id:'project',title:'Videos',slides:[{id:'slide',elements}]});
test('rejects the actual four stacked videos regression', () => {
  expect(() => validateDocument(doc(['a','b','c','d'].map(id => video(id))))).toThrow('videos superpuestos');
});
test('allows separate videos and text overlays without forcing one-video layouts', () => {
  expect(validateDocument(doc([video('a',0,960),video('b',960,960),{id:'text',type:'text',text:'Title',x:0,y:0,width:1920,height:100}])).videoCount).toBe(2);
});
test('rejects invalid geometry and duplicate identifiers', () => {
  for (const patch of [{x:NaN},{width:0},{x:1800},{height:-1}]) expect(() => validateDocument(doc([{...video('a'),...patch}]))).toThrow();
  expect(() => validateDocument(doc([video('a',0,960),video('a',960,960)]))).toThrow('id repetido');
  const d=doc([]);d.slides.push({id:'slide',elements:[]});expect(() => validateDocument(d)).toThrow();
});
