import{F as w,H as D,I as q,J as W,N as K,O as Z,g,i as I,j as R,k as j,u as x}from"./chunk-TIYFYHIV.js";import{Ca as O,Ea as A,F as S,Ja as N,L as $,Sa as P,Ta as B,Va as F,Wa as f,Ya as V,a as k,b as a,e as _,fa as v,g as M,h as T,i as l,k as G,r as y,u as E,v as z,va as U}from"./chunk-B73YYSBA.js";import{a as d}from"./chunk-LO2NM3CE.js";var J=["auto","all","favorites","nearby"],Q=h=>`loyalty_hub:card_mode:${h??""}:${typeof location<"u"?location.pathname:""}`;function X(h){try{let p=localStorage.getItem(Q(h));return J.includes(p)?p:null}catch{return null}}function Y(h,p){try{localStorage.setItem(Q(h),p)}catch{}}var C="/loyalty-hub";function L(h){let p=new Set,e=h.user?.id;if(!e)return p;let t=Object.values(h.states).filter(s=>s.entity_id.startsWith("person.")&&s.attributes?.user_id===e);for(let s of t)for(let r of Object.values(h.states)){if(!r.entity_id.startsWith("zone.")||r.entity_id==="zone.home")continue;let m=r.attributes?.friendly_name===s.state,u=Array.isArray(r.attributes?.persons)&&r.attributes.persons.includes(s.entity_id);(m||u)&&p.add(r.entity_id)}return p}var n=class extends M{constructor(){super(...arguments);this._config={type:"custom:loyalty-hub-card",mode:"auto",max_items:6,show_selector:!0};this._chosen=void 0;this._cards=[];this._loaded=!1;this._error="";this._open=null;this._openGroup=null;this._prefs=null;this._settings=null;this._busy=!1;this._cashier=!1;this._toast="";this._toastError=!1;this._auto=new K(()=>this._autoMarkUsed());this._unobserve=null;this._observedFor=null;this._unsub=null;this._subscribing=!1;this._initialized=!1;this._batcher=new z(()=>this.hass,()=>this._cards,e=>this._setCards(e),e=>{this._error=v(e)})}setConfig(e){if(!e)throw new Error("Invalid configuration");let t=e.mode??"auto";if(!J.includes(t))throw new Error(`Invalid mode: ${t}`);let s=Number(e.max_items??6);this._config={...e,mode:t,max_items:Number.isFinite(s)&&s>0?Math.floor(s):6,show_selector:e.show_selector!==!1}}getCardSize(){let e=Math.min(this._visible().length||1,this._config.max_items??6);return 1+Math.ceil(e/2)*2}connectedCallback(){super.connectedCallback(),this._initialized&&(this._batcher.push(null),this._subscribe()),this._auto.attach()}disconnectedCallback(){super.disconnectedCallback();let e=this._unsub;this._unsub=null,e&&Promise.resolve().then(e).catch(()=>{}),this._batcher.cancel(),clearTimeout(this._toastTimer),this._auto.detach(),this._stopObserving()}updated(){let e=this._open?.id??null;if(e!==this._observedFor&&(this._stopObserving(),this._auto.reset(),this._observedFor=e,!e&&this._cashier&&(this._cashier=!1)),e&&!this._unobserve){let t=this.renderRoot.querySelector(".barcode-box");t&&(this._unobserve=Z(t,s=>this._auto.setVisible("dialog",s)))}this._auto.setVisible("cashier",this._cashier)}_stopObserving(){this._unobserve?.(),this._unobserve=null,this._auto.setVisible("dialog",!1)}_showToast(e,t=!1){this._toast=e,this._toastError=t,clearTimeout(this._toastTimer),this._toastTimer=window.setTimeout(()=>{this._toast=""},3e3)}async _autoMarkUsed(){let e=this._open?.id;if(!(!e||this._open?.admin_view))try{let t=this._open?.use_count,s=await y(this.hass,e);this._open?.id===e&&(this._open=s),s.use_count!==t&&this._showToast(f(this.hass)("tiles_auto_used"))}catch{}}willUpdate(e){this._chosen===void 0&&this.hass?.user&&(this._chosen=X(this.hass.user.id)),e.has("hass")&&this.hass&&!this._initialized&&(this._initialized=!0,this._load(),this._subscribe())}async _subscribe(){if(!(this._unsub||this._subscribing||!this.hass||!this.isConnected)){this._subscribing=!0;try{let e=await E(this.hass,t=>this._batcher.push(t),void 0,void 0,{onSettings:()=>{$(this.hass).then(t=>{this._settings=t},()=>{})}});this.isConnected?this._unsub=e:await e()}catch{}finally{this._subscribing=!1}}}_setCards(e){this._cards=e,this._error="",this._open&&(this._open=this._cards.find(t=>t.id===this._open?.id)??null)}async _load(){S(this.hass).then(e=>{this._prefs=e},()=>{}),$(this.hass).then(e=>{this._settings=e},()=>{});try{this._setCards(await G(this.hass)),U(this.hass.user?.id).catch(()=>{})}catch(e){this._error=v(e)}finally{this._loaded=!0}}get _mode(){let e=this._config.mode??"auto";return this._config.show_selector===!1?e:this._chosen??e}_setMode(e){this._chosen=e,Y(this.hass?.user?.id,e)}_isNear(){if(!this.hass)return()=>!1;let e=L(this.hass);return t=>(t.zones??[]).some(s=>e.has(s))}_matcher(){let e=this._mode;return e==="favorites"?t=>t.favorite:e==="nearby"?this._isNear():()=>!0}_visibleGroups(){let e=this._matcher(),t=this._mode,s=this._cards.filter(c=>!c.admin_view),r=x("manual_order",this._settings,this._prefs)&&this._prefs?.list_order==="manual",m=t==="auto"?D(s,this._prefs,r):w(s),u=g(m,this._prefs,this.hass?.user?.id);if(t==="auto"){let c=q(u.map(i=>({group:i})),this._isNear());u=[...c.near,...c.favs,...c.rest].map(i=>i.group)}let o=[];for(let c of u){let i=c.cards.filter(e);if(!i.length)continue;let b=t==="all"||t==="auto"||i.length>1?j(c,{userId:this.hass?.user?.id,hass:this.hass}):i[0];o.push({group:c,first:i.includes(b)?b:i[0]})}return o.slice(0,this._config.max_items??6)}_visible(){return this._visibleGroups().map(e=>e.first)}get _openTabs(){let e=this._open;if(!e||!this._openGroup)return[];let t=g(w(this._cards.filter(s=>!s.admin_view)),this._prefs,this.hass?.user?.id).find(s=>s.key===this._openGroup&&s.cards.some(r=>r.id===e.id));return!t||t.cards.length<2?[]:t.cards.map((s,r)=>({card:s,label:I(s,r,this.hass?.user?.id)}))}_openGroupObj(){let e=this._open;if(!(!e||!this._openGroup))return g(this._cards.filter(t=>!t.admin_view),this._prefs,this.hass?.user?.id).find(t=>t.key===this._openGroup&&t.cards.some(s=>s.id===e.id))}_renderSelector(e,t){let s=[{m:"auto",label:e("mode_auto_short"),name:e("mode_auto")},{m:"all",label:e("mode_all"),name:e("mode_all")},{m:"favorites",label:"",name:e("mode_favorites"),icon:"mdi:star"},{m:"nearby",label:"",name:e("section_nearby"),icon:"mdi:map-marker-radius"}];return a`<div class="modes" role="radiogroup" aria-label=${e("card_mode_selector")}>
      ${s.map(r=>a`<button role="radio" aria-checked=${r.m===t?"true":"false"}
        aria-label=${r.name} title=${r.name} @click=${()=>this._setMode(r.m)}>
        ${r.icon?a`<ha-icon icon=${r.icon}></ha-icon>`:r.label}</button>`)}
    </div>`}_renderEmpty(e,t){return t==="favorites"?a`<div class="empty">${e("card_empty_favorites")}</div>`:t==="nearby"?a`<div class="empty">${e("card_empty_nearby")}
        ${this._config.show_selector!==!1?a`<button class="link" @click=${()=>this._setMode("auto")}>
          ${e("card_show_auto")}</button>`:_}</div>`:a`<div class="empty">${e("no_cards_card")}</div>`}_openCard(e,t){this._openGroup=e.cards.length>1?e.key:null,this._open=t}_selectTab(e){let t=this._cards.find(s=>s.id===e);!t||t.id===this._open?.id||(this._openGroup&&R(this.hass?.user?.id,this._openGroup,t.id),this._open=t)}async _markUsed(){if(this._open){this._busy=!0;try{this._open=await y(this.hass,this._open.id),this._showToast(f(this.hass)("marked_used"))}catch(e){this._showToast(f(this.hass)("error_generic",{msg:v(e)}),!0)}finally{this._busy=!1}}}_openHub(e,t){e.preventDefault(),this._open=null,A(t?`${C}?card=${encodeURIComponent(t)}`:C)}render(){if(!this.hass)return _;B(this.hass)||P(this.hass).then(i=>{i&&this.requestUpdate()},()=>{});let e=f(this.hass),t=F(this.hass),s=this._visibleGroups(),r=this._openTabs,m=x("high_contrast_cashier",this._settings,this._prefs)&&!!this._prefs?.cashier_high_contrast,u=this._mode,o=this._open,c=this._openGroupObj();return a`
      <ha-card>
        <div class="head">
          <ha-icon icon="mdi:wallet-membership"></ha-icon>
          <span class="title">${e("app_title")}</span>
        </div>
        ${this._config.show_selector!==!1?this._renderSelector(e,u):_}
        ${this._loaded?this._error&&!this._cards.length?a`<div class="empty error-text">${e("error_generic",{msg:this._error})}</div>`:s.length?a`<div class="grid">
              ${s.map(({group:i,first:b})=>a`<lh-card-tile .card=${i.cards[0]} .hass=${this.hass} .t=${e}
                language=${t} layout="grid" .groupCount=${i.cards.length} displayName=${i.name??""}
                @click=${()=>this._openCard(i,b)}></lh-card-tile>`)}
            </div>`:this._renderEmpty(e,u):a`<div class="empty">${e("loading")}</div>`}
        <div class="footer">
          <a href=${C} @click=${i=>this._openHub(i)}>${e("open_hub")}</a>
        </div>
      </ha-card>
      <lh-dialog .open=${!!o} heading=${c?.name||o?.name||""} close-label=${e("close")} @closed=${()=>{this._open=null}}>
        ${o?a`
          ${r.length?a`<div class="tabs" role="tablist" aria-label=${e("tiles_group_tabs")}>
            ${r.map(i=>a`<button role="tab" aria-selected=${i.card.id===o.id?"true":"false"}
              title=${i.card.name} @click=${()=>this._selectTab(i.card.id)}>${i.label}</button>`)}
          </div>`:_}
          <lh-card-tile class="hero" layout="large" .card=${o} .hass=${this.hass} .t=${e} language=${t}></lh-card-tile>
          <button class="barcode-box" aria-label=${e("tiles_cashier_open")} @click=${()=>{this._cashier=!0}}>
            <lh-barcode .code=${o.code} .format=${o.barcode_format}
              error-text=${e("render_error",{format:W[o.barcode_format]??o.barcode_format})}></lh-barcode>
            <div class="code-text">${o.code}</div>
            <span class="tap-hint">${e("tiles_cashier_tap")}</span>
          </button>
          <div class="info muted">
            ${o.kind==="voucher"&&o.balance!==null&&o.balance!==void 0?a`${e("balance")}: <strong>${N(o.balance,o.currency,t)}</strong>`:o.points!==null&&o.points!==void 0?e("points",{count:o.points}):_}
          </div>
          ${this._toast?a`<div class="toast ${this._toastError?"error-text":""}" role="status">${this._toast}</div>`:_}
          <lh-cashier-view .open=${this._cashier} .card=${o} .t=${e} .tabs=${r} ?high-contrast=${m}
            @tab-change=${i=>this._selectTab(i.detail.cardId)}
            @closed=${()=>{this._cashier=!1}}></lh-cashier-view>`:_}
        <button slot="actions" class="btn" @click=${i=>this._openHub(i,o?.id)}>
          <ha-icon icon="mdi:open-in-app"></ha-icon>${e("open_hub")}</button>
        <button slot="actions" class="btn primary" ?disabled=${this._busy} @click=${this._markUsed}>
          <ha-icon icon="mdi:check-circle"></ha-icon>${e("mark_used")}</button>
      </lh-dialog>
    `}};n.styles=[V,k`
    ha-card { padding: 12px 16px 8px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .head .title { flex: 1; font-size: 1.2em; font-weight: 500; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
    .empty { color: var(--secondary-text-color); padding: 8px 0 12px; }
    .empty .link {
      display: inline; border: none; background: none; padding: 0 0 0 4px; cursor: pointer; font: inherit;
      color: var(--primary-color); font-weight: 500; text-decoration: underline;
    }
    .modes { display: flex; gap: 6px; margin: 0 0 10px; flex-wrap: wrap; }
    .modes button {
      min-height: 36px; min-width: 44px; padding: 0 14px; border-radius: 18px; cursor: pointer; font: inherit;
      display: inline-flex; align-items: center; justify-content: center; --mdc-icon-size: 20px;
      border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color);
    }
    .modes button[aria-checked="true"] {
      background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent;
    }
    .modes button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    .footer { display: flex; justify-content: flex-end; margin-top: 8px; }
    .footer a { color: var(--primary-color); text-decoration: none; font-weight: 500; padding: 8px; }
    .barcode-box { margin-bottom: 12px; }
    .hero { max-width: 240px; margin: 0 auto 12px; }
    lh-barcode { width: 100%; }
    .info { margin-bottom: 8px; }
    button.barcode-box { width: 100%; border: none; cursor: pointer; font: inherit; }
    .tap-hint { color: #555; font-size: 0.8em; }
    .tabs { display: flex; gap: 6px; overflow-x: auto; margin: 0 0 10px; padding: 2px 0 6px; }
    .tabs button {
      flex: none; min-height: 36px; max-width: 50vw; padding: 0 14px; border-radius: 18px; cursor: pointer;
      border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); font: inherit;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tabs button[aria-selected="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
    .toast { font-size: 0.85em; color: var(--success-color, #2e7d32); margin-top: 4px; }
    .toast.error-text { color: var(--error-color, #db4437); }
  `],d([T({attribute:!1})],n.prototype,"hass",2),d([l()],n.prototype,"_config",2),d([l()],n.prototype,"_chosen",2),d([l()],n.prototype,"_cards",2),d([l()],n.prototype,"_loaded",2),d([l()],n.prototype,"_error",2),d([l()],n.prototype,"_open",2),d([l()],n.prototype,"_openGroup",2),d([l()],n.prototype,"_prefs",2),d([l()],n.prototype,"_settings",2),d([l()],n.prototype,"_busy",2),d([l()],n.prototype,"_cashier",2),d([l()],n.prototype,"_toast",2),d([l()],n.prototype,"_toastError",2);O("loyalty-hub-card-impl",n);export{J as CARD_MODES,n as LoyaltyHubCard,L as currentUserZones};
