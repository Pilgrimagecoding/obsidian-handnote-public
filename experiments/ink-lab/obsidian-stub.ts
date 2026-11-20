export const Platform = { isMobileApp: true, isIosApp: true, isDesktopApp: false };
export const normalizePath = (s: string) => s.replace(/^\/+/, '');
export class Notice { constructor(message: string) { console.log(message); const root = window as any; (root.__notices ??= []).push(message); } }
function element(tag = 'div', parent?: HTMLElement, options: any = {}): any {
  const el: any = document.createElement(tag); if (parent) parent.append(el);
  if (options.text) el.textContent = options.text;
  for (const [k,v] of Object.entries(options.attr ?? {})) el.setAttribute(k,v);
  el.setText = (text: string) => { el.textContent = text; };
  el.empty = () => el.replaceChildren();
  el.createEl = (tag: string, options: any) => element(tag,el,options);
  return el;
}
export class Modal {
  modalEl = element(); titleEl = element('h2',this.modalEl); contentEl = element('div',this.modalEl);
  constructor(public app: any) { this.modalEl.className = 'test-modal'; this.modalEl.style.cssText = 'position:fixed;z-index:10000;inset:20% 20%;background:white;color:black;padding:24px;overflow:auto'; }
  onOpen() {} onClose() {}
  open() { document.body.append(this.modalEl); this.onOpen(); }
  close() { this.onClose(); this.modalEl.remove(); }
}
export class Setting {
  el: any;
  constructor(parent: HTMLElement) { this.el = element('div',parent); }
  setName(name: string) { element('label',this.el,{text:name});return this; }
  addButton(fn: (button: any) => void) { const el = element('button',this.el);const button = { setButtonText(s:string){el.textContent=s;return button;}, setCta(){return button;},onClick(cb:()=>void){el.onclick=cb;return button;} }; fn(button); return this; }
  addText(fn:(text:any)=>void){const el=element('input',this.el);const tx={setValue(s:string){el.value=s;return tx;},onChange(cb:(s:string)=>void){el.oninput=()=>cb(el.value);return tx;}};fn(tx);return this;}
}
