import {useEffect,useState} from 'react';
import {DproMark} from './DproMark';
export function StartupSplash(){
 const [visible,setVisible]=useState(()=>typeof window!=='undefined'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 useEffect(()=>{const timer=setTimeout(()=>setVisible(false),2600);return()=>clearTimeout(timer);},[]);
 if(!visible)return null;
 return <div className="startup-splash" aria-label="Starting Dpro"><div className="startup-animation" role="img" aria-label="Dpro logo animation"/><div className="startup-static"><DproMark/></div><button type="button" onClick={()=>setVisible(false)}>Skip animation</button></div>;
}
