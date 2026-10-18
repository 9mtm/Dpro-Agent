import type {TokenKeep} from './session';
/** The bridge owns an HttpOnly cookie. JavaScript stores no reusable credential. */
export function localSessionKeep(hostname:string):TokenKeep|null {
 if(hostname!=='127.0.0.1')return null;
 return {load:()=> 'dpro-remembered-session',save:()=>{}};
}
