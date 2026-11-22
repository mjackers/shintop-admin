/* Local Excel import. Nothing is uploaded or published automatically. */
'use strict';
const byId=id=>document.getElementById(id);
const clean=v=>String(v??'').normalize('NFC').trim().toLowerCase().replace(/кapsen/g,'kapsen').replace(/\s+/g,' ').replace(/ё/g,'е');
function num(v){if(typeof v==='number')return Number.isFinite(v)?v:null;const s=String(v??'').replace(/[\s\u00a0₽]/g,'').replace(',','.');return /^\d+(\.\d+)?$/.test(s)?Number(s):null;}
function save(name,text,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
let catalog=null,mapping=null,nextCatalog=null,report=[],busy=false;
let catalogChosen=false;
function readyState(message){byId('analyze').disabled=!catalog;byId('backup').disabled=!catalog;byId('template').disabled=!catalog;byId('current-state').textContent=message;status(message);}
function status(text){byId('status').textContent=text;}
function invalidate(){nextCatalog=null;report=[];byId('publish').disabled=true;byId('report').disabled=true;byId('results').replaceChildren();}
function validate(data){if(!Array.isArray(data)||!data.length)throw Error('Каталог должен быть непустым массивом товаров.');const ids=new Set();for(const p of data){if(p.id===undefined||ids.has(String(p.id)))throw Error('В каталоге отсутствует ID или есть повторяющиеся ID.');ids.add(String(p.id));}return data;}
function addMap(map,key,id){if(!key)return;if(!map.has(key))map.set(key,new Set());map.get(key).add(String(id));}

function tireFromName(name){
 const m=String(name).trim().match(/^(\d{3}\s*\/\s*\d{2,3}\s*[rр]\s*\d{2}(?:\.5)?(?:c|lt)?|\d{3}\s*[rр]\s*\d{2}(?:c|lt)?|\d{2}(?:\.\d+)?\s*[*xх]\s*\d{1,2}\.\d+\s*[rр]\s*\d{2}(?:lt)?)\s+([\s\S]+)$/i);
 if(!m)return null;
 let rest=m[2],season=/летняя/i.test(rest)?'Лето':/зимняя|ошипованная|шипуемая/i.test(rest)?'Зима':/всесезон/i.test(rest)?'Всесезон':'';
 if(!/а\/шина/i.test(rest))return null;
 rest=rest.replace(/^[\s\S]*?а\/шина\s*/i,'');const used=/б\/у/i.test(rest);rest=rest.replace(/б\/у/gi,'').trim();
 const parts=rest.match(/^(\S+)\s+([\s\S]+)$/);if(!parts)return null;
 const aliases={atlander:'Atlander',yokohama:'Yokohama',ikon:'Ikon',pirelli:'Pirelli',kapsen:'Kapsen',dunlop:'Dunlop',sonix:'Sonix',powertrac:'Powertrac',maxxis:'Maxxis',toyo:'Toyo'};
 const brand=aliases[clean(parts[1])]||parts[1];rest=parts[2];
 const ym=rest.match(/\((20\d{2})\)|\/\/\s*(20\d{2})/);const year=ym?(ym[1]||ym[2]):'';
 const ixm=rest.match(/(?:^|\s)(\d{2,3}(?:\/\d{2,3})?[A-Z])(?=\s|$)/i),ix=ixm?ixm[1].toUpperCase():'';
 const xl=/\bXL\b/i.test(rest);
 let model=rest.replace(/\((20\d{2})\)|\/\/\s*20\d{2}|\bXL\b/gi,'');if(ixm)model=model.replace(ixm[0],' ');model=model.replace(/\s+/g,' ').trim();
 if(!model||!season)return null;
 const stud=/ошипованная/i.test(m[2])?'Шипованная':/шипуемая/i.test(m[2])?'Шипуемая':season==='Зима'?'Нешипованная':'';
 return {brand,model,size:m[1].replace(/\s/g,'').replace(/[рr]/gi,'R').replace(/c$/i,'C').replace(/lt$/i,'LT'),ix,season,year,used,xl,stud};
}
const identityPart=v=>clean(v).replace(/[^a-zа-я0-9]/g,'');
function identity(p){return [p.brand,p.model,p.size,p.ix,p.year,p.used?'used':'new',p.xl?'xl':'',p.season].map(identityPart).join('|');}

async function analyze(){
 if(busy)return;invalidate();busy=true;byId('analyze').disabled=true;
 try{
  if(!catalog)throw Error('Сначала выберите текущий products.json в шаге 1.');
  if(typeof XLSX==='undefined')throw Error('Не загрузился модуль Excel. Используйте новый файл inventory-import.html целиком.');
  const file=byId('excel').files[0];if(!file)throw Error('Выберите Excel.');if(file.size>20*1024*1024)throw Error('Максимальный размер Excel — 20 МБ.');
  status('Читаю Excel…');
  const book=XLSX.read(await file.arrayBuffer(),{type:'array',cellFormula:false,cellHTML:false,cellStyles:false});
  const mapByName=new Map(),mapBySku=new Map(),catalogById=new Map(catalog.map(p=>[String(p.id),p]));
  for(const entry of mapping?.entries||[]){addMap(mapByName,clean(entry.name),entry.id);if(entry.sku)addMap(mapBySku,clean(entry.sku),entry.id);}
  for(const p of catalog){if(p.importName)addMap(mapByName,clean(p.importName),p.id);if(p.importSku)addMap(mapBySku,clean(p.importSku),p.id);}
  const proposals=new Map(),rows=[],newDefinitions=new Map();let tables=0;
  let nextId=Math.max(999999,...catalog.map(p=>Number(p.id)||0))+1;
  for(const sheet of book.SheetNames){
   const matrix=XLSX.utils.sheet_to_json(book.Sheets[sheet],{header:1,defval:null,raw:true});
   let head=-1,cols={};
   for(let i=0;i<Math.min(150,matrix.length);i++){
    const names=matrix[i].map(clean);
    const q=names.findIndex(s=>/остаток|количество|^qty$/.test(s));
    const price=names.findIndex(s=>/цена продажи|^цена(?:,.*)?$|^price$/.test(s));
    const name=names.findIndex(s=>/номенклатура|наименование|^name$/.test(s));
    const id=names.findIndex(s=>s==='id'||s==='id товара');
    if(q>=0&&price>=0&&(name>=0||id>=0)){head=i;cols={q,price,name,id,sku:names.findIndex(s=>/по кат\.|артикул|^sku$/.test(s))};break;}
   }
   if(head<0)continue;tables++;
   for(let i=head+1;i<matrix.length;i++){
    const row=matrix[i],name=cols.name>=0?String(row[cols.name]??'').trim():'',rawId=cols.id>=0?row[cols.id]:null;
    if(!name&&(rawId===null||rawId===''))continue;
    if(/^(итого|всего|отбор:)/i.test(name))continue;
    if((row[cols.q]===null||row[cols.q]==='')&&(row[cols.price]===null||row[cols.price]===''))continue;
    const sku=cols.sku>=0?String(row[cols.sku]??'').trim():'';
    let ids=null,reason='';
    if(rawId!==null&&rawId!==''){ids=new Set([String(rawId)]);reason='ID';}
    else{
     const n=mapByName.get(clean(name)),s=sku?mapBySku.get(clean(sku)):null;
     if(n&&s){ids=new Set([...n].filter(id=>s.has(id)));if(!ids.size){reason='Конфликт наименования и артикула';}}
     else ids=n||s;
     if(!reason)reason=n?'Полное наименование':'Артикул';
    }
    const rec={sheet,row:i+1,name,id:'',status:'',oldPrice:'',price:'',oldQty:'',qty:''};rows.push(rec);
    let id,p,isNew=false;
    if(ids?.size===1){id=[...ids][0];p=catalogById.get(id);if(!p){rec.status='Неизвестный ID — исправьте ID или оставьте поле пустым для нового товара';continue;}}
    else if((ids&&ids.size>0)||reason.startsWith('Конфликт')){rec.status='Неоднозначное совпадение — пропущено';continue;}
    else{
     const parsed=tireFromName(name);
     if(!parsed){rec.status='Новая строка: не распознаны характеристики шины — пропущено';continue;}
     const exact=catalog.filter(x=>identity(x)===identity(parsed));
     if(exact.length===1){p=exact[0];id=String(p.id);}
     else if(exact.length>1){rec.status='Неоднозначное совпадение характеристик — пропущено';continue;}
     else{
      const similar=catalog.filter(x=>identityPart(x.brand)===identityPart(parsed.brand)&&identityPart(x.size)===identityPart(parsed.size)&&(identityPart(x.model).includes(identityPart(parsed.model))||identityPart(parsed.model).includes(identityPart(x.model))));
      if(similar.length){rec.status='Похож на существующий товар: проверьте год, индекс, модель и ID';continue;}
      const key=identity(parsed);if(newDefinitions.has(key)){id=newDefinitions.get(key).id;p=newDefinitions.get(key).product;}
      else{id=String(nextId++);p={id:Number(id),...parsed,qty:0,modelPhoto:false};newDefinitions.set(key,{id,product:p});}
      isNew=true;
     }
    }
    rec.id=id;rec.oldPrice=p.price??'';rec.oldQty=p.qty??'';
    const quantity=num(row[cols.q]),price=num(row[cols.price]),token=clean(row[cols.price]);
    if(quantity===null||quantity<0||!Number.isInteger(quantity)){rec.status='Некорректный остаток — строка пропущена';continue;}
    const noPrice=token===''||token==='нет'||token==='по запросу'||price===0;
    if(!noPrice&&(price===null||price<0)){rec.status='Некорректная цена — строка пропущена';continue;}
    rec.price=noPrice?'':price;rec.qty=quantity;rec.status='Готово';
    const change={rec,price:noPrice?null:price,qty:quantity,sku,name,isNew,product:p};
    if(!proposals.has(id))proposals.set(id,[]);proposals.get(id).push(change);
   }
  }
  if(!tables)throw Error('Не найдены колонки: Номенклатура (или ID), Остаток, Цена продажи.');
  const out=structuredClone(catalog),outById=new Map(out.map(p=>[String(p.id),p]));let applied=0,changed=0,added=0;
  for(const [id,list] of proposals){
   if(list.length>1){for(const c of list)c.rec.status='Повтор товара в Excel — все его строки пропущены';continue;}
   const c=list[0];let p=outById.get(id);if(c.isNew){p=structuredClone(c.product);out.push(p);outById.set(id,p);added++;}applied++;
   if((p.price??null)!==c.price||p.qty!==c.qty)changed++;
   if(c.price===null){delete p.price;delete p.pricePack;}else{p.price=c.price;p.pricePack=1;}
   p.qty=c.qty;p.importName=c.name;if(c.sku)p.importSku=c.sku;
   p.inventorySource={file:file.name,sheet:c.rec.sheet,row:c.rec.row,importedAt:new Date().toISOString(),unit:'RUB/шт'};
   if('availability'in p)p.availability=c.qty>0?'В наличии':'Нет в наличии';
   c.rec.status=c.isNew?'Добавлено':'Обновлено';
  }
  nextCatalog=out;report=rows;
  const summary=`Обработано: ${rows.length} строк. Сопоставлено: ${applied} товаров. Изменились: ${changed}. Добавлено: ${added}. С нулевым остатком: ${out.filter(p=>Number(p.qty)===0).length}. Не обновлялись: ${catalog.length-(applied-added)} товаров. Пропущено строк: ${rows.filter(r=>!['Обновлено','Добавлено'].includes(r.status)).length}.`;
  status(summary+' Отсутствующие в Excel товары сохранены без изменений.');
  const tbody=byId('results');for(const r of rows){const tr=document.createElement('tr');for(const v of [r.id,r.name,r.oldPrice,r.price,r.oldQty,r.qty,r.status]){const td=document.createElement('td');td.textContent=String(v);tr.append(td);}tbody.append(tr);}
  byId('publish').disabled=applied===0;byId('report').disabled=false;
 }catch(e){status('Ошибка: '+e.message);}finally{busy=false;byId('analyze').disabled=!catalog;}
}
byId('analyze').onclick=analyze;
byId('excel').onchange=invalidate;
byId('current').onchange=()=>status('Для публикации используется только актуальный каталог S3. Перезагрузите страницу для обновления.');
byId('publish').onclick=async()=>{
 if(!nextCatalog||!baseVersion)return;
 if(!confirm('Опубликовать проверенные цены и остатки? Перед записью будет сохранена резервная копия.'))return;
 byId('publish').disabled=true;
 try{const response=await fetch('/api/publish',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({version:baseVersion,products:nextCatalog})});const data=await response.json();if(!response.ok)throw Error(data.error||'Ошибка публикации');catalog=data.products;baseVersion=data.version;invalidate();status('Опубликовано в S3. Резервная копия: '+data.backup+'. Обновите витрину. CDN может потребовать очистки кеша.');}catch(e){status(e.message);byId('publish').disabled=false;}
};
byId('backup').onclick=()=>{if(catalog)save('products-backup.json',JSON.stringify(catalog,null,2));};
byId('report').onclick=()=>{const fields=['sheet','row','id','name','oldPrice','price','oldQty','qty','status'];const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';save('inventory-import-report.csv','\ufeff'+[fields.join(';'),...report.map(r=>fields.map(k=>esc(r[k])).join(';'))].join('\r\n'),'text/csv;charset=utf-8');};
byId('template').onclick=()=>{if(!catalog)return;const rows=catalog.map(p=>({'ID':p.id,'Номенклатура':p.importName||[p.size,p.season==='Зима'?'Зимняя':p.season==='Всесезон'?'Всесезонная':'Летняя','а/шина',p.brand,p.model,p.ix,p.xl?'XL':'',p.year?'('+p.year+')':'',p.used?'б/у':''].filter(Boolean).join(' '),'Остаток, шт':p.qty??'','Цена продажи, руб':p.price?Number(p.price)/(Number(p.pricePack||p.pack)||1):''}));const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'Шины');XLSX.writeFile(book,'shintop-price-stock-template.xlsx');};
let baseVersion=null,csrf=null;
async function loadCurrentCatalog(){try{const r=await fetch('/api/catalog',{cache:'no-store'});if(r.status===401){location.href='/login';return;}const data=await r.json();if(!r.ok)throw Error(data.error||'Ошибка каталога');const mapResponse=await fetch('/api/map',{cache:'no-store'});if(!mapResponse.ok)throw Error('Не загружена карта соответствий');mapping=await mapResponse.json();catalog=validate(data.products);baseVersion=data.version;csrf=data.csrf;readyState('Каталог прочитан напрямую из S3: '+catalog.length+' товаров. Выберите Excel.');}catch(e){readyState('Ошибка: '+e.message);}}
loadCurrentCatalog();
