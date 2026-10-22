import type {ReactNode} from 'react';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
export function PreferenceGroup({title,children,note}:{title:string;children:ReactNode;note?:string}){
 return <section className="preference-section" aria-label={title}><h3>{title}</h3><div className="preference-group">{children}</div>{note&&<p className="preference-note">{note}</p>}</section>;
}
export function PreferenceRow({title,description,icon,children}:{title:string;description?:string;icon?:UiIconName;children:ReactNode}){
 return <div className="preference-row">{icon&&<span className="preference-icon"><UiIcon name={icon} size={17}/></span>}<div className="preference-label"><strong>{title}</strong>{description&&<small>{description}</small>}</div><div className="preference-control">{children}</div></div>;
}
