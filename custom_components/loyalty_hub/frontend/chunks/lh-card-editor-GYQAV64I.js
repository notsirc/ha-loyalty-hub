import{Ca as h,Da as p,Sa as f,Ta as g,Wa as u,Ya as _,a as n,b as l,e as r,g as c,h as d,i as m}from"./chunk-B73YYSBA.js";import{a as s}from"./chunk-LO2NM3CE.js";var i=class extends c{constructor(){super(...arguments);this._config={type:"custom:loyalty-hub-card"}}setConfig(e){this._config={...e}}_update(e){this._config={...this._config,...e},p(this,"config-changed",{config:this._config})}render(){if(!this._config)return r;g(this.hass)||f(this.hass).then(t=>{t&&this.requestUpdate()},()=>{});let e=u(this.hass),o=this._config.mode??"auto";return l`
      <div class="field">
        <label for="mode">${e("mode_initial")}</label>
        <select id="mode" @change=${t=>this._update({mode:t.target.value})}>
          <option value="auto" ?selected=${o==="auto"}>${e("mode_auto")}</option>
          <option value="all" ?selected=${o==="all"}>${e("mode_all")}</option>
          <option value="favorites" ?selected=${o==="favorites"}>${e("mode_favorites")}</option>
          <option value="nearby" ?selected=${o==="nearby"}>${e("mode_nearby")}</option>
        </select>
      </div>
      <div class="field">
        <label for="max">${e("max_items")}</label>
        <input id="max" type="number" min="1" max="50" .value=${String(this._config.max_items??6)}
          @change=${t=>{let a=parseInt(t.target.value,10);this._update({max_items:Number.isFinite(a)&&a>0?Math.min(a,50):6})}} />
      </div>
      <label class="check"><input type="checkbox" .checked=${this._config.show_selector!==!1}
        @change=${t=>this._update({show_selector:t.target.checked})} />
        ${e("editor_show_selector")}</label>
      <div class="hint muted">${e("editor_show_selector_help")}</div>
    `}};i.styles=[_,n`
    :host { display: block; padding: 8px 0; }
    .check { display: flex; align-items: center; gap: 8px; min-height: 40px; }
    .hint { margin: 0 0 8px 30px; line-height: 1.4; }
  `],s([d({attribute:!1})],i.prototype,"hass",2),s([m()],i.prototype,"_config",2);h("loyalty-hub-card-editor",i);export{i as LoyaltyHubCardEditor};
