/* 星穹桌面 · 星穹引擎 (sky-engine.js)
   由 sky.html 的内联 <script> 抽取而来, 供单一窗口 index.html 以 <script src> 加载。
   渲染目标 canvas = #sky; 悬停提示 = #tip。
   暴露 window.SkyHost(冻结接口): onVisible / onQueryResult / track / query
     + 只读属性 obs / tracked / sky / counts, 以及并入 OBS 的 applyObs()。
   调试钩子长期保留: #probe / #track=<hip> / #q=<text>(#q 输入框在控制台, id="q")。
   面板侧代码只经 SkyHost, 绝不直接碰 canvas(契约 §3 铁律)。 */
(function(){
"use strict";
var RAD=Math.PI/180, TAU=Math.PI*2;

/* 重要恒星名 (HIP → 名称)；含 20 颗原有亮星 + 46 颗著名导航星(中文名 + 拉丁名)。
   新增项均已核对 hipparcos_5.js: HIP 存在且星等/赤纬与该星一致 */
var STAR_NAMES={32349:"天狼星 Sirius",30438:"老人星 Canopus",69673:"大角星 Arcturus",91262:"织女星 Vega",
  24608:"五车二 Capella",24436:"参宿七 Rigel",37279:"南河三 Procyon",27989:"参宿四 Betelgeuse",
  11767:"北极星 Polaris",21421:"毕宿五 Aldebaran",65474:"角宿一 Spica",80763:"心宿二 Antares",
  97649:"牛郎星 Altair",49669:"轩辕十四 Regulus",113368:"北落师门 Fomalhaut",37826:"北河三 Pollux",
  36850:"北河二 Castor",102098:"天津四 Deneb",71683:"南门二 α Cen",25336:"参宿五 Bellatrix",
  746:"王良一 Caph",3179:"王良四 Schedar",9640:"天大将军一 Almach",677:"壁宿二 Alpheratz",9884:"娄宿三 Hamal",
  15863:"天船三 Mirfak",14135:"天囷一 Menkar",8102:"天仓五 Tau Ceti",7588:"水委一 Achernar",30324:"军市一 Mirzam",
  33579:"弧矢七 Adhara",25930:"参宿三 Mintaka",26727:"参宿一 Alnitak",27366:"参宿六 Saiph",26311:"参宿二 Alnilam",
  25428:"五车五 Elnath",31681:"井宿三 Alhena",34444:"弧矢一 Wezen",41037:"船尾座ε Avior",45238:"船底座θ Miaplacidus",
  60718:"十字架二 Acrux",62434:"十字架三 Mimosa",61084:"十字架一 Gacrux",68702:"马腹一 Hadar",68933:"库楼三 Menkent",
  46390:"星宿一 Alphard",50583:"轩辕十二 Algieba",57632:"五帝座一 Denebola",53910:"天璇 Merak",54061:"天枢 Dubhe",
  58001:"天玑 Phecda",62956:"玉衡 Alioth",65378:"开阳 Mizar",67301:"摇光 Alkaid",59774:"天权 Megrez",
  85927:"尾宿八 Shaula",90185:"箕宿三 Kaus Australis",92855:"斗宿四 Nunki",107315:"危宿三 Enif",113963:"室宿一 Markab",
  109268:"鹤一 Alnair",100751:"孔雀十一 Peacock",3419:"土司空 Diphda",86032:"侯 Rasalhague",87833:"天棓四 Eltanin",
  82273:"三角形三 Atria"};

/* ===== 观测者 ===== */
/* 不请求浏览器定位(壁纸环境会弹系统权限框)；覆盖位置：localStorage.setItem('skydome.obs','{"lat":28.23,"lon":112.94,"city":"长沙"}')。
   合并后主入口: SkyHost.applyObs(state.sky.obs) 覆盖。localStorage 仅作回退。 */
var OBS={lat:28.23, lon:112.94, city:"长沙"};
(function(){ try{ var o=JSON.parse(localStorage.getItem('skydome.obs')||'null'); if(o&&typeof o.lat==='number'&&typeof o.lon==='number'){ OBS.lat=o.lat; OBS.lon=o.lon; OBS.city=o.city||'自定义位置'; } }catch(e){} })();
/* ===== 时间流速(壁纸动感) ===== */
/* 默认 ×120：天空约 12 分钟转一圈，肉眼可见地缓慢流动；1 = 完全实时(几乎静止)。
   覆盖：localStorage.setItem('skydome.speed','300') */
var SPEED=1;
(function(){ try{ var s=parseFloat(localStorage.getItem('skydome.speed')); if(s===1||(s>=30&&s<=3600)){ SPEED=s; } }catch(e){} })();
var T0=Date.now();
function skyNow(){
  /* 以【今天(本地)】为基准: 真实时刻 + 加速量, 对 24h 取模 → 加速到当天末尾就回到 00:00 重来。
     SPEED=1 时 = 真实时间(星图与此刻天象一致); SPEED>1 时在当天内循环。 */
  var ds=new Date(); ds.setHours(0,0,0,0);
  var day=86400000;
  var realMs=Date.now()-ds.getTime();
  var extra=(Date.now()-T0)*(SPEED-1);
  var sim=(((realMs+extra)%day)+day)%day;
  return new Date(ds.getTime()+sim);
}
function refreshObserverGd(){ obsGd={longitude:OBS.lon*RAD,latitude:OBS.lat*RAD,height:0.05}; }
var obsGd={longitude:OBS.lon*RAD,latitude:OBS.lat*RAD,height:0.05};

/* ===== 天文 ===== */
function julian(d){ return d.getTime()/86400000+2440587.5; }
function gmstDeg(d){ var x=280.46061837+360.98564736629*(julian(d)-2451545.0); x%=360; if(x<0)x+=360; return x; }
function lstDeg(d){ var x=(gmstDeg(d)+OBS.lon)%360; if(x<0)x+=360; return x; }
function altAz(raDeg,decDeg,latDeg,lst){
  var H=(lst-raDeg)*RAD, dec=decDeg*RAD, lat=latDeg*RAD;
  var s=Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(H); s=Math.max(-1,Math.min(1,s));
  var alt=Math.asin(s)/RAD;
  var A=Math.atan2(Math.sin(H),Math.cos(H)*Math.sin(lat)-Math.tan(dec)*Math.cos(lat))/RAD;
  return {alt:alt, az:((A+180)%360+360)%360};
}
var M_GE=[[-0.0548755604,0.4941094279,-0.8676661490],[-0.8734370902,-0.4448296300,-0.1980763734],[-0.4838350155,0.7469822445,0.4559837762]];
function galToEq(lDeg,bDeg){ var l=lDeg*RAD,b=bDeg*RAD,x=Math.cos(b)*Math.cos(l),y=Math.cos(b)*Math.sin(l),z=Math.sin(b);
  var a=M_GE[0][0]*x+M_GE[0][1]*y+M_GE[0][2]*z, b2=M_GE[1][0]*x+M_GE[1][1]*y+M_GE[1][2]*z, c=M_GE[2][0]*x+M_GE[2][1]*y+M_GE[2][2]*z;
  var ra=Math.atan2(b2,a)/RAD; if(ra<0)ra+=360; return {ra:ra, dec:Math.asin(c)/RAD}; }

/* ===== 画布 ===== */
var cv=document.getElementById('sky'), mainCtx=cv.getContext('2d'), ctx=mainCtx, W=0,H=0;
/* 离屏场景缓存: 重活(银河/星轨/1600星/卫星/标注)只在"场景帧"跑一次, 每帧仅 drawImage+流星 → CPU 大降 */
var sceneCv=document.createElement('canvas'), sceneCtx=sceneCv.getContext('2d');
var SCENE_IDLE_MS=1500, SCENE_HOT_MS=140, _lastScene=0;
function project(az,alt){ return [(az/360)*W,(1-Math.max(alt,0)/90)*H]; }
function resize(){ var DPR=Math.min(window.devicePixelRatio||1,2); W=innerWidth; H=innerHeight;
  cv.width=W*DPR; cv.height=H*DPR; cv.style.width=W+'px'; cv.style.height=H+'px'; ctx.setTransform(DPR,0,0,DPR,0,0);
  sceneCv.width=W*DPR; sceneCv.height=H*DPR; sceneCtx.setTransform(DPR,0,0,DPR,0,0); _lastScene=0; }

/* ===== 格子保留区 ===== */
var ZONES=[];   /* 2026-10-16 关闭: 旧 DeskBox 保留区会切断星轨/留暗块; 格子已浮动+可折叠, 不再需要 */
function inZone(x,y){ for(var i=0;i<ZONES.length;i++){ var z=ZONES[i]; if(x>=z[0]*W&&x<=(z[0]+z[2])*W&&y>=z[1]*H&&y<=(z[1]+z[3])*H) return true; } return false; }

/* ===== 星表 + 星色 ===== */
var stars=[], LABEL_MAG=2.5;   /* 无名星标注代号的最大星等(越小标注越少) */
function bvColor(bv){ if(bv<-0.10) return [170,191,255]; if(bv<0.30) return [202,215,255]; if(bv<0.60) return [248,247,255]; if(bv<1.00) return [255,244,234]; if(bv<1.50) return [255,210,161]; return [255,181,108]; }
function buildStars(){ var cat=window.hipparcos_catalog; if(!cat) return;
  for(var i=0;i<cat.length;i++){ var s=cat[i]; if(!s) continue;
    var mag=s[2],ra=s[4],de=s[5],bv=s[13],hip=s[0],plx=s[7];
    if(typeof mag!=='number'||typeof ra!=='number'||typeof de!=='number'||mag>6.25) continue;
    var dist=null; if(typeof plx==='number'&&plx>0){ var d=1000/plx*3.26156; dist=(d<100?Math.round(d*10)/10:Math.round(d)); }
    var st={hip:hip,ra:ra,dec:de,mag:mag,bv:(typeof bv==='number'?bv:0.6),name:STAR_NAMES[hip]||null,dist:dist};
    st.col=bvColor(st.bv);   /* 预计算颜色(只由 bv 决定) → 渲染每帧不再调 bvColor() 分配数组 */
    stars.push(st); }
}

/* ===== 银河(沿银道面预计算) ===== */
var mwPts=[]; for(var _l=0;_l<=360;_l+=4){ mwPts.push(galToEq(_l,0)); }

/* ===== 卫星 ===== */
var sats=[], cssSat=null;
var FALLBACK_TLE=["CSS (TIANHE)","1 48274U 21035A   26288.24410899  .00023064  00000+0  27253-3 0  9995","2 48274  41.4694 312.8000 0000702 139.8855 220.2036 15.60756584311914",
 "ISS (ZARYA)","1 25544U 98067A   26288.50000000  .00016717  00000+0  30000-3 0  9993","2 25544  51.6400 208.0000 0004000  90.0000 270.0000 15.50000000450000"];
function parseTLE(txt){ var ls=txt.split(/\r?\n/).filter(function(l){return l.trim()!=="";}),out=[],name=null;
  for(var i=0;i<ls.length;i++){ var l=ls[i]; if(l.charAt(0)==='1'&&ls[i+1]&&ls[i+1].charAt(0)==='2'){ out.push({name:(name||("SAT"+(i-1))).trim(),l1:l,l2:ls[i+1]}); i++; } else name=l; } return out; }
function isCss(n){ return /CSS|TIANHE|天和|天宫/i.test(n); }
function buildSatrecs(list){ sats=[]; cssSat=null;
  for(var i=0;i<list.length;i++){ try{ var rec=satellite.twoline2satrec(list[i].l1,list[i].l2);
    var o={name:list[i].name.replace(/\(.*?\)/g,'').trim()||list[i].name,rec:rec,trail:[],css:isCss(list[i].name)};
    sats.push(o); if(o.css&&!cssSat) cssSat=o; }catch(e){} }
}
function loadTLE(){ var url="https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle";
  fetch(url).then(function(r){return r.text();}).then(function(t){ var l=parseTLE(t); buildSatrecs(l.length?l:parseTLE(FALLBACK_TLE.join("\n"))); })
  .catch(function(){ buildSatrecs(parseTLE(FALLBACK_TLE.join("\n"))); }); }
function lookOf(rec,d){ var pv=satellite.propagate(rec,d); if(!pv||!pv.position) return null;
  var g=satellite.gstime(d), ecf=satellite.eciToEcf(pv.position,g), lk=satellite.ecfToLookAngles(obsGd,ecf);
  return {alt:lk.elevation/RAD, az:lk.azimuth/RAD}; }

/* ===== 鼠标 ===== */
var mouseX=-1, mouseY=-1, mouseOn=false;
/* 悬停: #sky 是 pointer-events:none(不挡点击) → 画布收不到鼠标事件。
   改由主进程每 40ms 轮询的全局光标喂进来(经 preload.onCursor), 穿透时也能悬停。 */
if(window.shell&&window.shell.onCursor){ window.shell.onCursor(function(p){ if(p){ mouseX=p.x; mouseY=p.y; mouseOn=!p.ui; } }); }
else { cv.addEventListener('mousemove',function(e){ mouseX=e.clientX; mouseY=e.clientY; mouseOn=true; }); cv.addEventListener('mouseleave',function(){ mouseOn=false; }); }
var tip=document.getElementById('tip');

/* ===== 绘制 ===== */
var showGrid=false;   /* 经纬网格线默认关(用户嫌乱), 需要可改回 true */
function drawGrid(){ ctx.lineWidth=0.6; ctx.strokeStyle='rgba(90,150,220,0.11)';
  for(var alt=0;alt<=90;alt+=15){ var y=(1-alt/90)*H; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  for(var az=0;az<360;az+=30){ var x=(az/360)*W; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); } }

function drawMilkyWay(lst){ var pts=[];
  for(var i=0;i<mwPts.length;i++){ var aa=altAz(mwPts[i].ra,mwPts[i].dec,OBS.lat,lst); pts.push(project(aa.az,aa.alt)); }
  var WIDTHS=[60,30,13], ALPHAS=[0.032,0.058,0.086];
  for(var pass=0;pass<3;pass++){ ctx.strokeStyle='rgba(150,182,238,'+ALPHAS[pass]+')'; ctx.lineWidth=WIDTHS[pass]; ctx.lineCap='round'; ctx.beginPath(); var st=false;
    for(var k=0;k<pts.length;k++){ var pt=pts[k]; if(inZone(pt[0],pt[1])){ st=false; continue; }
      if(!st){ ctx.moveTo(pt[0],pt[1]); st=true; } else { if(Math.abs(pts[k][0]-pts[k-1][0])>W*0.4) ctx.moveTo(pt[0],pt[1]); else ctx.lineTo(pt[0],pt[1]); } }
    ctx.stroke(); } }

/* 中国空间站(天和)金色轨道: 轨道移动极慢(真实时间约 0.065°/s, 每秒只挪 ~0.2px) →
   投影点最多每 1000ms 重算一次, 每帧只重描缓存的折线段(去掉 ~101 次 propagate/帧)。
   缓存保留原分段语义: 地平线下(alt<4) / 保留区 / 跨经度(W*0.4 跳变) 都是断点。 */
var _cssOrbit={at:0, segs:null};
function drawCssOrbit(){ if(!cssSat) return; var now=Date.now();
  if(!_cssOrbit.segs || (now-_cssOrbit.at)>1000){
    _cssOrbit.at=now; var segs=[], cur=null, prev=null;
    for(var m=-50;m<=50;m+=1){ var L=lookOf(cssSat.rec,new Date(now+m*60000)); if(!L||L.alt<4){ cur=null; prev=null; continue; }
      var p=project(L.az,L.alt); if(inZone(p[0],p[1])){ cur=null; prev=null; continue; }
      if(!cur){ cur=[p]; segs.push(cur); }
      else if(prev&&Math.abs(p[0]-prev[0])>W*0.4){ cur=[p]; segs.push(cur); }
      else cur.push(p);
      prev=p; }
    _cssOrbit.segs=segs; }
  var segs2=_cssOrbit.segs; if(!segs2||!segs2.length) return;
  ctx.strokeStyle='rgba(255,201,90,0.24)'; ctx.lineWidth=1.6;
  for(var si=0;si<segs2.length;si++){ var seg=segs2[si]; if(seg.length<2) continue;
    ctx.beginPath(); ctx.moveTo(seg[0][0],seg[0][1]);
    for(var k=1;k<seg.length;k++) ctx.lineTo(seg[k][0],seg[k][1]);
    ctx.stroke(); } }

var orbitStars=[];
function pickOrbitStars(){              // 轮换: 选 2-3 颗在星穹中、方位均匀铺开的亮星
  var lst=lstDeg(skyNow()), cand=[];
  for(var i=0;i<stars.length;i++){ var s=stars[i]; if(!s.name) continue;
    var aa=altAz(s.ra,s.dec,OBS.lat,lst); if(aa.alt<16) continue; cand.push({s:s,az:aa.az}); }
  cand.sort(function(a,b){return a.az-b.az;});
  var n=Math.min(3,cand.length), picked=[];
  for(var k=0;k<n;k++){ picked.push(cand[Math.floor(k*cand.length/n)].s); }
  orbitStars=picked; }

function drawOrbitStars(){              // 2-3 颗亮星的亮蓝色长轨道弧
  var lst=lstDeg(skyNow());
  for(var i=0;i<orbitStars.length;i++){ var s=orbitStars[i]; var prev=null;
    ctx.strokeStyle='rgba(130,200,255,0.48)'; ctx.lineWidth=1.15; ctx.beginPath();
    for(var k=-78;k<=78;k+=2){ var l2=((lst+k)%360+360)%360; var aa=altAz(s.ra,s.dec,OBS.lat,l2);
      if(aa.alt<-2){ prev=null; continue; } var p=project(aa.az,aa.alt);
      if(inZone(p[0],p[1])){ prev=null; continue; }
      if(prev && Math.abs(p[0]-prev[0])<W*0.4) ctx.lineTo(p[0],p[1]); else ctx.moveTo(p[0],p[1]); prev=p; }
    ctx.stroke();
    var aa0=altAz(s.ra,s.dec,OBS.lat,lst);
    if(aa0.alt>-2){ var pp=project(aa0.az,aa0.alt);
      ctx.strokeStyle='rgba(150,215,255,0.85)'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(pp[0],pp[1],5,0,TAU); ctx.stroke(); } } }

/* 星: 全局都有短星轨(连续) + 高亮悬停 + 追踪高亮 */
var hoverStar=null, hoverP=null;
var trackStar=null;      /* 被追踪的恒星对象(点击列表行或搜索命中后设置) */
var TRAIL_MAG=4.0;       /* 只有 mag<=4 的星(约 514 颗)才计算/绘制星轨 —— 暗星无可见星轨, 省 altAz */
/* 逐星缓存: 每帧每颗星只算一次 altAz/投影/颜色, 存进预分配数组(复用, 不产生每帧堆分配)。
   字段: hip / alt / x / y / mag / col / ref(原星对象) / tX,tY,has(星轨终点)。 */
var _sb=null;
function ensureStarBufs(n){
  if(_sb && _sb.n>=n) return;
  _sb={ n:n,
    hip:new Int32Array(n), alt:new Float64Array(n), x:new Float64Array(n), y:new Float64Array(n),
    mag:new Float64Array(n), col:new Array(n), ref:new Array(n),
    tX:new Float64Array(n), tY:new Float64Array(n), has:new Uint8Array(n) };
}
function drawStars(lst){
  var lst2=((lst-0.85)%360+360)%360, tm=Date.now()*0.0012;
  var probe=(location.hash==='#probe'), probeS=null, probePP=null;
  hoverStar=null; hoverP=null; var hd=15*15;
  var n=stars.length; ensureStarBufs(n); var B=_sb, cnt=0;

  /* 第一遍: 每颗星只算一次 altAz + 投影 + 颜色, 缓存进预分配数组 */
  for(var i=0;i<n;i++){ var s=stars[i];
    var aa=altAz(s.ra,s.dec,OBS.lat,lst); if(aa.alt<-1) continue;
    var k=cnt++;
    B.hip[k]=s.hip; B.alt[k]=aa.alt; B.x[k]=(aa.az/360)*W; B.y[k]=(1-Math.max(aa.alt,0)/90)*H;
    B.mag[k]=s.mag; B.col[k]=s.col; B.ref[k]=s; B.has[k]=0;
    /* 星轨(lst2)只对亮星(mag<=TRAIL_MAG)或被追踪的星计算 */
    if(s.mag<=TRAIL_MAG || (trackStar && trackStar.hip===s.hip)){
      var aa2=altAz(s.ra,s.dec,OBS.lat,lst2);
      if(aa2.alt>-1){ B.tX[k]=(aa2.az/360)*W; B.tY[k]=(1-Math.max(aa2.alt,0)/90)*H; B.has[k]=1; } } }

  /* 第二遍: 按原顺序逐星画「星轨→圆点」(与旧代码同序), 悬停判定复用缓存 */
  for(var j=0;j<cnt;j++){ var s2=B.ref[j], px=B.x[j], py=B.y[j], col=B.col[j], mag=B.mag[j], alt=B.alt[j];
    if(probe && !probeS && s2.name && alt>20 && !inZone(px,py)){ probeS=s2; probePP=[px,py]; }
    if(B.has[j]){ var tx=B.tX[j], ty=B.tY[j];
      var tracked=(trackStar&&trackStar.hip===s2.hip);
      if(tracked){ ctx.strokeStyle='rgba(255,212,121,0.30)'; ctx.lineWidth=4.6;
        ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(px,py); ctx.stroke(); }
      var ta=Math.max(0.05,Math.min(0.42,0.5-mag*0.07));
      ctx.strokeStyle='rgba('+col[0]+','+col[1]+','+col[2]+','+(tracked?0.95:ta)+')';
      ctx.lineWidth=tracked?2.6:0.9;
      ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(px,py); ctx.stroke(); }
    var sz=Math.max(0.5,2.4-mag*0.30), al=Math.max(0.12,Math.min(0.95,1.02-mag*0.135));
    if((s2.hip&1)===0) al*=0.70+0.30*Math.sin(tm+(s2.hip%97));
    if(alt<8) al*=((alt+1)/9)*0.7+0.3;
    if(inZone(px,py)) al*=0.5;
    ctx.fillStyle='rgba('+col[0]+','+col[1]+','+col[2]+','+al+')';
    ctx.beginPath(); ctx.arc(px,py,sz,0,TAU); ctx.fill();
    if(mouseOn){ var dx=px-mouseX, dy=py-mouseY, dd=dx*dx+dy*dy; if(dd<hd){ hd=dd; hoverStar=s2; hoverP=[px,py]; } } }

  // 星名(复用缓存)：有名字写名字，没名字写 HIP 代号(无名星只标到 LABEL_MAG，避免满屏字)
  ctx.font='11px Consolas,"Microsoft YaHei",monospace';
  for(var m2=0;m2<cnt;m2++){ var s3=B.ref[m2];
    if(!s3.name && B.mag[m2]>LABEL_MAG) continue;
    if(B.alt[m2]<(s3.name?12:20)) continue;
    if(inZone(B.x[m2],B.y[m2])) continue;
    ctx.fillStyle=s3.name?'rgba(150,205,255,0.5)':'rgba(120,162,200,0.30)';
    ctx.fillText(s3.name||('HIP '+s3.hip), B.x[m2]+7, B.y[m2]+3); }

  // 追踪中的恒星: 金色圆环 + 强辉光 + 金色标名
  if(trackStar){ var at=altAz(trackStar.ra,trackStar.dec,OBS.lat,lst);
    if(at.alt>-1){ var pt=[(at.az/360)*W,(1-Math.max(at.alt,0)/90)*H];
      ctx.save(); ctx.shadowColor='rgba(255,212,121,.95)'; ctx.shadowBlur=20; ctx.fillStyle='#fff3d6';
      ctx.beginPath(); ctx.arc(pt[0],pt[1],4.4,0,TAU); ctx.fill(); ctx.restore();
      ctx.strokeStyle='rgba(255,212,121,.92)'; ctx.lineWidth=1.7; ctx.beginPath(); ctx.arc(pt[0],pt[1],10.5,0,TAU); ctx.stroke();
      ctx.strokeStyle='rgba(255,212,121,.32)'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(pt[0],pt[1],16,0,TAU); ctx.stroke();
      ctx.fillStyle='rgba(255,226,170,.95)'; ctx.font='11px Consolas,"Microsoft YaHei",monospace';
      ctx.fillText(trackStar.name||('HIP '+trackStar.hip), pt[0]+12, pt[1]-7); } }

  // 悬停: 星放亮 + 信息
  if(!hoverStar && probe && probeS){ hoverStar=probeS; hoverP=probePP; }
  if(hoverStar && hoverP){
    ctx.fillStyle='#eaf6ff'; ctx.shadowColor='#bfe4ff'; ctx.shadowBlur=16;
    ctx.beginPath(); ctx.arc(hoverP[0],hoverP[1],3.6,0,TAU); ctx.fill(); ctx.shadowBlur=0;
    ctx.strokeStyle='rgba(191,228,255,0.8)'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(hoverP[0],hoverP[1],9,0,TAU); ctx.stroke();
    var nm=hoverStar.name||('HIP '+hoverStar.hip);
    tip.innerHTML='<span class="nm">'+nm+'</span><span class="mg">星等 '+hoverStar.mag.toFixed(2)+'</span><span class="mg">距离 '+(hoverStar.dist?hoverStar.dist+' 光年':'未知')+'</span>';
    tip.style.left=((probe?hoverP[0]:mouseX)+16)+'px'; tip.style.top=((probe?hoverP[1]:mouseY)+14)+'px'; tip.style.opacity='1';
  } else { tip.style.opacity='0'; }
}

/* 卫星: 位置传播(propagate)与轨迹追加节流到 ~4Hz —— 卫星按真实时间(非 ×120)行走, 很慢,
   4Hz 足够顺(每步约 0.4px); 每帧只重描缓存的轨迹 + 缓存标记。轨迹长度上限保持 150 点。 */
var _sat={at:0, vis:[]};
function drawSats(now){ if(!sats.length) return _sat.vis;
  var t=now&&now.getTime?now.getTime():Date.now();
  if(t-_sat.at>=250 || !_sat.vis.length){
    _sat.at=t;
    var gmst=satellite.gstime(now), vis=[];
    for(var i=0;i<sats.length;i++){ var s=sats[i]; var pv=satellite.propagate(s.rec,now);
      if(!pv||!pv.position){ s.trail.length=0; continue; }
      var ecf=satellite.eciToEcf(pv.position,gmst), lk=satellite.ecfToLookAngles(obsGd,ecf);
      var alt=lk.elevation/RAD, az=lk.azimuth/RAD; if(alt<0){ s.trail.length=0; continue; }
      var p=project(az,alt), last=s.trail[s.trail.length-1];
      if(!last||Math.abs(last[0]-p[0])<W*0.4) s.trail.push(p); else s.trail=[p];
      if(s.trail.length>150) s.trail.shift();
      vis.push({name:s.name,alt:alt,az:az,p:p,css:s.css}); }
    _sat.vis=vis; }
  var vis2=_sat.vis;
  for(var k=0;k<sats.length;k++){ var s2=sats[k],tr=s2.trail; if(tr.length<2) continue;
    ctx.strokeStyle=s2.css?'rgba(255,201,90,0.75)':'rgba(120,210,255,0.45)'; ctx.lineWidth=s2.css?1.8:1.2;
    ctx.beginPath(); ctx.moveTo(tr[0][0],tr[0][1]);
    for(var j=1;j<tr.length;j++){ if(Math.abs(tr[j][0]-tr[j-1][0])>W*0.4) ctx.moveTo(tr[j][0],tr[j][1]); else ctx.lineTo(tr[j][0],tr[j][1]); } ctx.stroke(); }
  for(var m=0;m<vis2.length;m++){ var v=vis2[m];
    if(v.css){ ctx.fillStyle='#ffcf6a'; ctx.shadowColor='#ffc84a'; ctx.shadowBlur=14; ctx.beginPath(); ctx.arc(v.p[0],v.p[1],3.6,0,TAU); ctx.fill(); ctx.shadowBlur=0;
      ctx.fillStyle='rgba(255,207,106,0.9)'; ctx.font='11px Consolas,monospace'; ctx.fillText('天和',v.p[0]+7,v.p[1]+3); }
    else { ctx.fillStyle='#bfe8ff'; ctx.beginPath(); ctx.arc(v.p[0],v.p[1],2.4,0,TAU); ctx.fill(); } }
  return vis2; }

/* ===== 星穹引擎 (W2 侧: 可见列表 / 搜索 / 追踪) —— 面板不直接调用, 只经 SkyHost ===== */
var HIP_TOTAL=1606;   // hipparcos_5.js 星表条目数(用于未命中提示)
function findStarByHip(hip){ for(var i=0;i<stars.length;i++){ if(stars[i].hip===hip) return stars[i]; } return null; }
function visibleTrailed(){        // 当前可见 + 带可见星轨 + 可标注, 最亮优先, 上限 9(3×3) → 契约 sky:visible
  var lst=lstDeg(skyNow()), lst2=((lst-0.85)%360+360)%360, out=[];
  for(var i=0;i<stars.length;i++){ var s=stars[i];
    if(!s.name && s.mag>LABEL_MAG) continue;         // 只列会被标注的星(有名 或 无名但够亮)
    var aa=altAz(s.ra,s.dec,OBS.lat,lst); if(aa.alt<-1) continue;    // 当前在地平线上
    var a2=altAz(s.ra,s.dec,OBS.lat,lst2); if(a2.alt<=-1) continue;  // 且带一段可见星轨
    out.push({hip:s.hip,name:s.name,mag:s.mag,dist:(s.dist?s.dist+' 光年':'未知'),alt:aa.alt}); }
  out.sort(function(a,b){ return a.mag-b.mag; });    // 最亮优先
  return out.slice(0,9); }
function countVisibleStars(){       // 当前在地平线上的"可标注"恒星数(有名 或 无名但够亮) → 控制台 "恒星 N"
  var lst=lstDeg(skyNow()), n=0;
  for(var i=0;i<stars.length;i++){ var s=stars[i];
    if(!s.name && s.mag>LABEL_MAG) continue;
    if(altAz(s.ra,s.dec,OBS.lat,lst).alt>0) n++; }
  return n; }
var SKY={                            // 引擎侧动作(由 SkyHost 调用)
  track:function(hip){ if(hip==null){ trackStar=null; return; } var s=findStarByHip(hip); if(s) trackStar=s; },
  query:function(txt){               // 行为与旧 runSearch 逐字一致
    txt=(txt||'').trim(); if(!txt) return {ok:true,found:false,msg:'',cls:''};
    var hit=null, q=txt.toLowerCase();
    if(/^\d+$/.test(txt)){ hit=findStarByHip(parseInt(txt,10)); }   // 全数字 → 按 HIP 号
    else { for(var i=0;i<stars.length;i++){ var s=stars[i];         // 否则子串匹配名字(中文/拉丁)
        if(s.name&&s.name.toLowerCase().indexOf(q)>=0){ hit=s; break; } }
      if(!hit){ for(var j=0;j<stars.length;j++){ if(('hip '+stars[j].hip).indexOf(q)>=0){ hit=stars[j]; break; } } } }
    if(!hit) return {ok:false,found:false,msg:'星表中无此星（本表为 Hipparcos '+HIP_TOTAL+' 颗亮星）',cls:'no'};
    var aa=altAz(hit.ra,hit.dec,OBS.lat,lstDeg(skyNow()));
    if(aa.alt>0){ trackStar=hit; return {ok:true,found:true,msg:'已找到 · 高度 '+Math.round(aa.alt)+'°',cls:'ok'}; }
    return {ok:true,found:true,msg:'已找到 · 当前在地平线下',cls:'dim'}; }
};

/* ===== SkyHost 适配层 (面板↔星穹 唯一接口) =====
   合并为单窗口后 = 本地实现(直接调 SKY); 将来若要再拆窗, 只需把本对象体换成 IPC, 面板代码一行不改。
   冻结的 IPC 通道名(如再拆窗直接复用):
     面板 → 星穹   sky:track(hip|null)              sky:query(text)
     星穹 → 面板   sky:visible([{hip,name,mag,dist,alt}])
                   sky:query-result({ok,found,msg,cls})   sky:tracked(hip|null)   */
window.SkyHost=(function(){
  var _l={};
  function emitVisible(){ if(_l.visible) _l.visible(visibleTrailed()); }   // 星穹 → 面板: sky:visible
  function curTracked(){ return trackStar?trackStar.hip:null; }
  var api={
    onVisible:function(cb){ _l.visible=cb; if(cb) cb(visibleTrailed()); },  // 订阅 sky:visible(订阅即回一份快照)
    onQueryResult:function(cb){ _l.qres=cb; },                             // 订阅 sky:query-result
    track:function(hip){ SKY.track(hip); emitVisible(); },                 // 面板 → 星穹: sky:track, 再回发 sky:tracked
    query:function(text){ var r=SKY.query(text); if(_l.qres) _l.qres(r); emitVisible(); },  // sky:query → sky:query-result
    /* 合并后新增: 由 state.json 的 sky.obs 喂观测者(localStorage 'skydome.obs' 仅作回退) */
    applyObs:function(o){ if(!o) return;
      if(typeof o.lat==='number') OBS.lat=o.lat;
      if(typeof o.lon==='number') OBS.lon=o.lon;
      if(o.city) OBS.city=o.city;
      refreshObserverGd(); },
    _emitVisible:emitVisible
  };
  /* 状态: 与 state.json 的 sky 逐字同形(localStorage 'skydome.obs' 覆盖已并入 OBS) */
  Object.defineProperty(api,'obs',    {enumerable:true,get:function(){ return {lat:OBS.lat,lon:OBS.lon,city:OBS.city}; }});
  Object.defineProperty(api,'tracked',{enumerable:true,get:function(){ return curTracked(); }});
  Object.defineProperty(api,'sky',    {enumerable:true,get:function(){ return {obs:{lat:OBS.lat,lon:OBS.lon,city:OBS.city},track:curTracked()}; }});
  /* 计数: 控制台展示 "恒星 N · 在轨 M" (N=当前地平线上可标注恒星数, total=星表总数, onOrbit=在轨卫星数) */
  Object.defineProperty(api,'counts', {enumerable:true,get:function(){ return {total:HIP_TOTAL, visible:countVisibleStars(), onOrbit:sats.length}; }});
  /* 中国空间站(天和) 实时状态: 控制台紧凑态显示 "天和 · 高度 N° / 地平线下" */
  Object.defineProperty(api,'css', {enumerable:true,get:function(){
    if(!cssSat) return {name:'天和', alt:null, visible:false, ready:false};
    var L=null; try{ L=lookOf(cssSat.rec,new Date()); }catch(e){}
    var alt=(L&&typeof L.alt==='number')?L.alt:null;
    return {name:'天和', alt:alt, visible:(alt!=null&&alt>=0), ready:true};
  }});
  /* 时间流速(壁纸动感): 控制台按钮循环切换; 持久到 localStorage('skydome.speed') */
  Object.defineProperty(api,'speed', {enumerable:true,get:function(){ return SPEED; }});
  api.setSpeed = function(n){ var v=Number(n); if(!isFinite(v)||v<0) return SPEED; SPEED=v; try{ localStorage.setItem('skydome.speed', String(v)); }catch(e){} return SPEED; };
  api.setPaused = function(b){ PAUSED = !!b; };
  return api;
})();

function veil(){ for(var i=0;i<ZONES.length;i++){ var z=ZONES[i]; ctx.fillStyle='rgba(3,7,14,0.30)'; ctx.fillRect(z[0]*W,z[1]*H,z[2]*W,z[3]*H); } }

/* ===== 流星 ===== */
var meteors=[], nextMeteor=0;
function spawnMeteor(){ meteors.push({x:W*(0.08+Math.random()*0.84), y:H*(0.03+Math.random()*0.5),
  vx:(Math.random()<0.5?-1:1)*(240+Math.random()*240), vy:170+Math.random()*150, life:0, max:0.7+Math.random()*0.6}); }
function drawMeteors(dt){ var t=Date.now(); if(!nextMeteor) nextMeteor=t+2500+Math.random()*4500;
  if(t>nextMeteor && meteors.length<2){ spawnMeteor(); nextMeteor=t+12000+Math.random()*22000; }
  for(var i=meteors.length-1;i>=0;i--){ var m=meteors[i]; m.life+=dt; if(m.life>=m.max){ meteors.splice(i,1); continue; }
    m.x+=m.vx*dt; m.y+=m.vy*dt; var a=Math.sin(Math.PI*m.life/m.max);
    ctx.strokeStyle='rgba(205,232,255,'+(0.85*a)+')'; ctx.lineWidth=1.6; ctx.beginPath();
    ctx.moveTo(m.x-m.vx*0.09,m.y-m.vy*0.09); ctx.lineTo(m.x,m.y); ctx.stroke();
    ctx.strokeStyle='rgba(160,205,255,'+(0.28*a)+')'; ctx.lineWidth=0.9; ctx.beginPath();
    ctx.moveTo(m.x-m.vx*0.22,m.y-m.vy*0.22); ctx.lineTo(m.x,m.y); ctx.stroke(); } }

var _pt=0, _last=0, _lastEmit=0, PAUSED=false;   /* PAUSED: 普通桌面模式下暂停绘制(画布已隐藏) */
/* 帧率上限: 壁纸无需按满刷新率(120Hz)渲染。20=省电低占用(默认), 30/60=更顺滑。
   覆盖: localStorage.setItem('skydome.fps','30'|'60'|'120') */
var FPS_CAP=(SPEED<=1?12:20);   /* 实时(天空几乎不动): 12fps 足够; 加速时 20fps (localStorage 'skydome.fps' 可覆盖) */
(function(){ try{ var f=parseInt(localStorage.getItem('skydome.fps'),10); if(f===20||f===30||f===60||f===120) FPS_CAP=f; }catch(e){} })();
var FRAME_MS=1000/FPS_CAP;
/* 重活: 把一帧"场景"画到离屏画布(银河/星轨/星/卫星/标注/暗带) */
function renderScene(){
  var now=new Date(), lst=lstDeg(skyNow());
  ctx=sceneCtx;
  var g=ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#02040c'); g.addColorStop(0.55,'#040814'); g.addColorStop(1,'#071021');
  ctx.globalCompositeOperation='source-over'; ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  if(showGrid) drawGrid();
  drawMilkyWay(lst); drawCssOrbit(); drawOrbitStars(); drawStars(lst);
  drawSats(now); veil();
  ctx=mainCtx;
}
function frame(ts){ if(typeof ts!=='number') ts=performance.now();
  requestAnimationFrame(frame);                     /* 先排下一帧, 保证节流不打断循环 */
  if(PAUSED) return;                                /* 普通桌面模式: 暂停绘制 */
  if(_last && ts-_last<FRAME_MS) return;            /* 未到间隔: 跳过本帧绘制 */
  _last=ts;
  var dt=_pt?Math.max(0,Math.min(0.2,(ts-_pt)/1000)):0.016; _pt=ts;
  /* 场景只在"场景帧"重算: 空闲 1.5s 一次(默认实时, 天空几乎不动); 悬停星空时 140ms(保响应) */
  var sceneMs = mouseOn ? SCENE_HOT_MS : SCENE_IDLE_MS;
  if(ts-_lastScene>=sceneMs){ _lastScene=ts; renderScene(); }
  ctx=mainCtx;
  mainCtx.globalCompositeOperation='source-over';
  mainCtx.drawImage(sceneCv,0,0,W,H);               /* 轻: 贴图 */
  drawMeteors(dt);                                  /* 流星仍逐帧 → 顺滑 */
  if(ts-_lastEmit>=2500){ _lastEmit=ts; SkyHost._emitVisible(); }
}

addEventListener('resize',resize);
resize(); buildStars(); refreshObserverGd(); loadTLE();
SkyHost._emitVisible();  /* 面板已随合并迁入本页 → 仅广播一次(init 无 DOM 写入, 保证其后的 requestAnimationFrame(frame) 一定执行) */
/* 调试钩子(同 #probe 风格, 生产无害): #track=<hip> 开机即追踪某星; #q=<文本> 开机预填并搜索
   (#q 的输入框=控制台 #q; 若尚未就绪则为 null, 有 if(qi) 保护, 只走 SkyHost.query 广播) */
(function(){ var h=location.hash||'';
  var tm=h.match(/[#&]track=(\d+)/); if(tm){ SkyHost.track(parseInt(tm[1],10)); }
  var qm=h.match(/[#&]q=([^&]+)/); if(qm){ var t=decodeURIComponent(qm[1]); var qi=document.getElementById('q');
    if(qi) qi.value=t; SkyHost.query(t); } })();
pickOrbitStars(); setInterval(pickOrbitStars, 30000);
requestAnimationFrame(frame);
})();
