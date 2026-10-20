export const titles={bookings:'预约记录',rooms:'影棚状态',people:'人员配置'};
export const singular={bookings:'预约',rooms:'摄影间',people:'人员'};
export const columns={bookings:[['name','拍摄主题'],['roomId','摄影间'],['personId','预约人'],['time','预约时间'],['status','状态'],['note','备注']],rooms:[['name','摄影间名称'],['code','空间编号'],['status','当前状态'],['recent','最近使用人'],['kind','类型'],['area','面积（㎡）'],['location','位置'],['equipment','设备配置'],['note','空间说明']],people:[['name','姓名'],['role','角色'],['team','所属团队'],['email','邮箱'],['phone','电话'],['note','人员备注']]};
export function orderedColumns(entity,data){
    const available=[...columns[entity],...data.fields[entity].map(f=>[f.id,f.name])],byId=new Map(available);
    const order=[...(data.columnOrder?.[entity]||[]),...available.map(([id])=>id)];
    return [...new Set(order)].filter(id=>byId.has(id)).map(id=>[id,byId.get(id)]);
}
export const colors={violet:'鸢尾紫',blue:'雾蓝',orange:'暖橙',green:'松绿',rose:'玫瑰',slate:'石墨',crimson:'绯红',amber:'琥珀',lime:'青柠',emerald:'翡翠',teal:'青碧',cyan:'湖青',sky:'晴空',indigo:'靛蓝',plum:'梅紫',fuchsia:'洋红',coral:'珊瑚',sand:'沙金'};
export const groups=[['彩色',['crimson','orange','amber','green','teal','blue','violet','rose']],['中性',['sand','slate']]];
export const palette=groups.flatMap(g=>g[1]);
export const dateInput=(d=Date.now())=>new Date(new Date(d).getTime()+8*3600000).toISOString().slice(0,16);
export const dayKey=d=>dateInput(d).slice(0,10);
export const timeText=d=>dateInput(d).slice(11,16);
export const dateText=d=>{const s=dateInput(d);return s.slice(5,7)+'月'+s.slice(8,10)+'日';};
export const endDay=b=>dayKey(Date.parse(b.end)-1);
export const allDay=b=>timeText(b.start)==='00:00'&&timeText(b.end)==='00:00';
export const range=(start,end,previous)=>({start:previous&&start===dayKey(previous.start)?previous.start:new Date(start+'T00:00+08:00').toISOString(),end:previous&&end===endDay(previous)?previous.end:new Date(Date.parse(end+'T00:00+08:00')+86400000).toISOString()});
export const bookingStatus=(b,now=Date.now())=>Date.parse(b.start)>now?'待开始':Date.parse(b.end)>now?'使用中':'已结束';
export function roomInfo(room,data,now=Date.now()){const list=data.bookings.filter(b=>b.roomId===room.id);return {active:list.find(b=>Date.parse(b.start)<=now&&now<Date.parse(b.end)),recent:list.filter(b=>Date.parse(b.start)<=now).sort((a,b)=>Date.parse(b.start)-Date.parse(a.start))[0],next:list.filter(b=>Date.parse(b.start)>now).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))[0]};}
export const roomStatus=(r,d,now)=>r.blocked?'不可预约':roomInfo(r,d,now).active?'使用中':'可预约';
export const compareEnd=(a,b)=>Date.parse(b.end)-Date.parse(a.end);
export function reorder(rows,source,target){const a=rows.findIndex(r=>r.id===source),b=rows.findIndex(r=>r.id===target);if(a<0||b<0||a===b)return rows;const next=rows.slice();next.splice(b,0,next.splice(a,1)[0]);return next;}
export const avatarSrc=(p,v)=>'/api/avatars?personId='+encodeURIComponent(p)+(v?'&v='+v:'');
// Compare the original form, local edits and latest record before rebasing a save.
export function mergeRecord(base,draft,latest){
    if(!latest)throw Error('这条记录已被删除，无法保存。请关闭窗口并查看最新记录。');
    const merged={...latest,extra:{...latest.extra}},conflicts=[];
    const equal=(key,a,b)=>key==='blocked'?!!a===!!b:a===b;
    for(const key of Object.keys(draft)){
        if(key==='id'||key==='extra')continue;
        if(equal(key,draft[key],base[key]))continue;
        if(!equal(key,latest[key],base[key])&&!equal(key,latest[key],draft[key]))conflicts.push(key);
        else if(draft[key]===undefined)delete merged[key];
        else merged[key]=draft[key];
    }
    for(const key of new Set([...Object.keys(base.extra||{}),...Object.keys(draft.extra||{})])){
        const old=base.extra?.[key]||'',mine=draft.extra?.[key]||'',theirs=latest.extra?.[key]||'';
        if(mine===old)continue;
        if(theirs!==old&&theirs!==mine)conflicts.push(key);
        else merged.extra[key]=mine;
    }
    if(conflicts.length){
        const labels={name:'名称',roomId:'摄影间',personId:'预约人',start:'开始日期',end:'结束日期',blocked:'屏蔽状态',note:'备注',avatar:'头像',...Object.fromEntries(Object.values(columns).flat())};
        throw Error('以下内容也被其他人修改：'+conflicts.map(k=>labels[k]||'自定义信息').join('、')+'。您的填写内容仍保留，请先复制需要保留的内容，再关闭并重新打开记录核对。');
    }
    return merged;
}
export function imageInfo(b){const n=(a,s=2,l=false)=>{let v=0;for(let i=0;i<s;i++)v=v*256+b[a+(l?s-1-i:i)];return v;};const str=(a,z)=>String.fromCharCode(...b.slice(a,z));let mime,w,h;if(b.length>=24&&str(0,8)==='\x89PNG\r\n\x1a\n'&&str(12,16)==='IHDR'){mime='image/png';w=n(16,4);h=n(20,4);}else if(b.length>=10&&['GIF87a','GIF89a'].includes(str(0,6))){mime='image/gif';w=n(6,2,true);h=n(8,2,true);}else if(b.length>=16&&str(0,4)==='RIFF'&&str(8,12)==='WEBP'){mime='image/webp';const k=str(12,16);if(k==='VP8 '&&b.length>=30){w=n(26,2,true)&16383;h=n(28,2,true)&16383;}else if(k==='VP8L'&&b.length>=25){const bits=n(21,4,true);w=(bits&16383)+1;h=((bits>>>14)&16383)+1;}else if(k==='VP8X'&&b.length>=30){w=n(24,3,true)+1;h=n(27,3,true)+1;}}else if(b[0]===255&&b[1]===216){let a=2;while(a+9<=b.length){if(b[a]!==255){a++;continue;}const m=b[a+1];if(m===255){a++;continue;}if(m===1||(m>=208&&m<=217)){a+=2;continue;}if(m===218)break;const l=n(a+2);if(l<2)break;if(m>=192&&m<=207&&![196,200,204].includes(m)){mime='image/jpeg';h=n(a+5);w=n(a+7);break;}a+=2+l;}}return w&&h?{mime,width:w,height:h}:null;}
export function avatarError(size,info){if(size>3*1024*1024)return '图片不能超过 3MB';if(!info)return '无法读取图片信息，请上传 PNG、JPEG、WebP 或 GIF 图片';if(info.width>2048||info.height>2048)return `图片尺寸不能超过 2048×2048 像素（当前 ${info.width}×${info.height}）`;}
