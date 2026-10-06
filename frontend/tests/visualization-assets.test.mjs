import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {cwd} from "node:process";

const bundle=await build({stdin:{contents:`
 import {createRoot} from 'react-dom/client';
 import {flushSync} from 'react-dom';
 import {PrivateImage} from './frontend/src/visualizations/PrivateImage';
 export {createGalleryClient} from './frontend/src/visualizations/client';
 export {preloadImage} from './shared/visualizations/ImageComparison';
 export function mount(target,client,photos){const root=createRoot(target);
  flushSync(()=>root.render(<>{photos.map(photo=><PrivateImage key={photo.id} sourceKey={photo.id} source={()=>client.windowSource(photo)} alt={photo.title}/>)}</>));
  return ()=>flushSync(()=>root.unmount());
 }
`,resolveDir:cwd(),loader:"tsx"},bundle:true,write:false,format:"iife",globalName:"AssetTest",platform:"browser",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'}});
const id=(n)=>`a0000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const photos=Array.from({length:20},(_,i)=>({id:id(i+1),title:`Window ${i+1}`,revision:1,width:1024,height:1024,cleanup:true,createdAt:"2026-10-06T12:00:00Z"}));
async function until(condition,message){for(let i=0;i<100;i++){if(condition())return;await delay(5);}assert.fail(message);}
function setup(t,{size=51697,blocked=false}={}){
 const dom=new JSDOM("<div id='mount'></div>",{url:"https://shop.example/",runScripts:"outside-only",pretendToBeVisual:true}),w=dom.window;
 Object.assign(w,{Response,Headers,Request,AbortSignal,AbortController});
 const active=new Map(),revoked=new Set(),requests=[],observers=[],deferred=[];let index=0,livePhotos=photos;
 w.URL.createObjectURL=blob=>{const url=`blob:https://shop.example/${++index}`;active.set(url,blob);return url;};
 w.URL.revokeObjectURL=url=>{assert.ok(active.has(url),"URL release must be idempotent");active.delete(url);revoked.add(url);};
 w.IntersectionObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
 w.HTMLImageElement.prototype.decode=async()=>{};
 Object.defineProperty(w.HTMLImageElement.prototype,"naturalWidth",{get:()=>1024});
 const gallery=()=>({enabled:true,liveWindowIds:livePhotos.map(p=>p.id),liveVisualizationIds:[],windows:livePhotos,visualizations:[],nextWindowsCursor:null,nextVisualizationsCursor:null});
 const json=value=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
 w.fetch=async url=>{
  if(String(url).includes("/apps/roman/gallery"))return json({credential:{ownerId:id(99),token:"a".repeat(43),apiBaseUrl:"https://roman.example/api/gallery"},gallery:gallery()});
  if(String(url).endsWith("/list"))return json(gallery());
  requests.push(String(url));
  const response=new Response(new Uint8Array(size),{headers:{"content-type":"image/jpeg"}});
  if(blocked){const read=response.blob.bind(response);response.blob=()=>new Promise(resolve=>deferred.push(()=>void read().then(resolve)));}
  return response;
 };
 w.eval(bundle.outputFiles[0].text);const client=w.AssetTest.createGalleryClient({getSnapshot:()=>({conversation:null})});
 const mount=w.document.querySelector("#mount");let unmount;
 t.after(()=>{unmount?.();client.dispose();assert.equal(active.size,0);dom.window.close();});
 return{w,client,mount,active,revoked,requests,observers,deferred,deletePhotos(){livePhotos=[];},mountPhotos(){unmount=w.AssetTest.mount(mount,client,photos);}};
}

test("20 concurrent Gallery consumers retain valid URLs through cache eviction and release offscreen, then resolve again",async t=>{
 const f=setup(t);await f.client.initialize();f.mountPhotos();
 f.observers.forEach(observer=>observer.callback([{isIntersecting:true}]));
 await until(()=>f.mount.querySelectorAll("img").length===20,"all visible consumers should resolve");
 assert.equal(f.active.size,20);assert.equal(f.revoked.size,0);
 for(const image of f.mount.querySelectorAll("img"))assert.ok(f.active.has(image.src),"mounted image must retain its valid private URL");
 assert.equal(f.requests.length,20);
 f.observers.forEach(observer=>observer.callback([{isIntersecting:false}]));
 await until(()=>!f.mount.querySelector("img"),"offscreen images should drop their src");
 assert.equal(f.active.size,0);assert.equal(f.revoked.size,20);
 f.observers.forEach(observer=>observer.callback([{isIntersecting:true}]));
 await until(()=>f.mount.querySelectorAll("img").length===20,"returning images should resolve again");
 assert.equal(f.requests.length,28,"12 compressed images remain cached; eight evicted images are fetched again");
 for(const image of f.mount.querySelectorAll("img"))assert.ok(f.active.has(image.src));
});

test("private URL leases have a bounded count without evicting an existing consumer",async t=>{
 const f=setup(t);await f.client.initialize();
 const leases=await Promise.all(Array.from({length:65},()=>f.client.windowSource(photos[0])));
 assert.equal(leases.filter(Boolean).length,64);assert.equal(leases.at(-1),null);
 assert.equal(f.active.size,64);assert.equal(f.requests.length,1,"one Blob fetch is shared across concurrent consumers");
 leases[0].release();leases[0].release();
 const reopened=await f.client.windowSource(photos[0]);assert.ok(reopened);assert.equal(f.active.size,64);
 f.client.dispose();assert.equal(f.active.size,0);
 leases.forEach(lease=>lease?.release());reopened.release();
});

test("compressed cache and live consumer bytes are independently bounded",async t=>{
 const f=setup(t,{size:9*1024*1024});await f.client.initialize();
 const leases=await Promise.all(photos.slice(0,8).map(photo=>f.client.windowSource(photo)));
 assert.equal(leases.filter(Boolean).length,7,"live consumers cannot retain more than64MiB of distinct Blob bytes");
 assert.equal(f.active.size,7);assert.equal(f.revoked.size,0);
 leases.forEach(lease=>lease?.release());
 const recent=await f.client.windowSource(photos[7]);assert.ok(recent);recent.release();
 assert.equal(f.requests.length,8,"recent image is still within32MiB compressed cache");
 const evicted=await f.client.windowSource(photos[0]);assert.ok(evicted);evicted.release();
 assert.equal(f.requests.length,9,"old compressed image is fetched again after byte-budget eviction");
});

test("late private media responses after disposal cannot allocate URLs",async t=>{
 const f=setup(t,{blocked:true});await f.client.initialize();
 const source=f.client.windowSource(photos[0]);await until(()=>f.deferred.length===1,"body should be pending");
 f.client.dispose();f.deferred[0]();
 assert.equal(await source,null);assert.equal(f.active.size,0);assert.equal(f.revoked.size,0);
});

test("late image resolution after it leaves view releases its unconsumed lease",async t=>{
 const f=setup(t,{blocked:true});await f.client.initialize();f.mountPhotos();
 f.observers[0].callback([{isIntersecting:true}]);await until(()=>f.deferred.length===1,"body should be pending");
 f.observers[0].callback([{isIntersecting:false}]);f.deferred[0]();
 await until(()=>f.revoked.size===1,"stale image resolution must release its lease");
 assert.equal(f.active.size,0);assert.equal(f.mount.querySelector("img"),null);
});

test("photos deleted in another tab invalidate active leases and reject late media responses",async t=>{
 const f=setup(t,{blocked:true});await f.client.initialize();
 const source=f.client.windowSource(photos[0]);await until(()=>f.deferred.length===1,"first body should be pending");f.deferred[0]();
 const lease=await source;assert.ok(lease);assert.equal(f.active.size,1);
 const late=f.client.windowSource(photos[1]);await until(()=>f.deferred.length===2,"second body should be pending");
 f.deletePhotos();await f.client.refresh();assert.equal(f.active.size,0);
 f.deferred[1]();assert.equal(await late,null);assert.equal(f.revoked.size,1);
 lease.release();
});
