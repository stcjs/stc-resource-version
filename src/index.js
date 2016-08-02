import Plugin from 'stc-plugin';
import path from 'path';

import {
  isRemoteUrl, 
  md5, 
  ResourceRegExp, 
  htmlTagResourceAttrs,
  extend
} from 'stc-helper';

/**
 * default options
 */
const defaultOpts = {
  type: 'query',
  length: 5
}

/**
 * upload resource to cdn
 */
export default class ResourceVersionPlugin extends Plugin {
  /**
   * run
   */
  async run(){
    this.options = extend({}, defaultOpts, this.options);

    if(this.isTpl()){
      return this.parseHtml();
    }
    let extname = this.file.extname;
    switch(extname){
      case 'js':
        return this.parseJs();
      case 'css':
        return this.parseCss();
      default:
        let content = await this.getContent('binary');
        let filepath = await this.getFilePath(content, this.file.path);
        return {filepath};
    }
  }
  /**
   * parse html
   */
  async parseHtml(){
    let tokens = await this.getAst();
    let promises = tokens.map(token => {
      switch(token.type){
        case this.TokenType.HTML_TAG_START:
          return this.parseHtmlTagStart(token);
        case this.TokenType.HTML_TAG_SCRIPT:
          return this.parseHtmlTagScript(token);
        case this.TokenType.HTML_TAG_STYLE:
          return this.parseHtmlTagStyle(token);
      }
    });
    await Promise.all(promises);
    return {ast: tokens};
  }
  /**
   * parse js
   */
  async parseJs(){
    let content = await this.getContent('utf8');
    content = await this.parseJsResource(content);
    let filepath = await this.getFilePath(content, this.file.path);
    return {filepath, content};
  }
  /**
   * parse js resource
   * {cdn: "path/to/resource"}.cdn
   */
  parseJsResource(content){
    return this.asyncReplace(content, ResourceRegExp.cdn, async (a, b, c, d) => {
      let filepath = await this.getUrlByInvoke(d);
      return `"${filepath}"`;
    });
  }
  /**
   * parse css
   */
  async parseCss(){
    let tokens = await this.getAst();
    let property = '';
    let promises = tokens.map(async (token) => {
      if(token.type === this.TokenType.CSS_PROPERTY){
        property = token.ext.value.toLowerCase();
      }
      if(token.type !== this.TokenType.CSS_VALUE){
        return;
      }
      if(property){
        token.ext.value = await this.replaceCssResource(token.ext.value, property);
        property = '';
      }
    });
    await Promise.all(promises);

    // virtual file
    if(this.file.prop('virtual')){
      return tokens;
    }
    this.file.setAst(tokens);
    let content = await this.file.getContent('utf8');
    let filepath = await this.getFilePath(content, this.file.path);
    return {filepath, ast: tokens};
  }
  /**
   * replace css resource
   */
  replaceCssResource(value, property){
    // ie filter
    if(property === 'filter'){
      return this.asyncReplace(value, ResourceRegExp.filter, async (a, b, p) => {
        if(isRemoteUrl(p)){
          return `src=${b}${p}${b}`;
        }
        let filepath = await this.getUrlByInvoke(p);
        return `src=${b}${filepath}${b}`;
      });
    }
    // font-face
    if(property === 'src'){
      return this.asyncReplace(value, ResourceRegExp.font, async (a, b, p, suffix) => {
        if(isRemoteUrl(p)){
          return `url(${p}${suffix})`;
        }
        let filepath = await this.getUrlByInvoke(p);
        return `url(${filepath}${suffix})`;
      });
    }
    // background image
    return this.asyncReplace(value, ResourceRegExp.background, async (a, b, p) => {
      if(isRemoteUrl(p)){
        return `url(${p})`;
      }
      let filepath = await this.getUrlByInvoke(p);
      return `url(${filepath})`;
    });
  }
  /**
   * get file path
   */
  async getFilePath(content, filepath){
    let originPath = this.prop('originPath') || filepath;
    let hash = md5(content).slice(0, this.options.length);
    if(this.options.type === 'query'){
      return `${originPath}?v=${hash}`;
    }
    originPath = originPath.replace(/(\.\w+)$/, `_${hash}$1`);
    filepath = filepath.replace(/(\.\w+)$/, `_${hash}$1`);
    await this.addFile('/' + filepath, new Buffer(content, 'binary'));
    return originPath;
  }
  /**
   * get url by invoke plugin
   */
  async getUrlByInvoke(filepath){
    let {exclude} = this.options;
    if(exclude && this.stc.resource.match(filepath, exclude)){
      return Promise.resolve(filepath);
    }
    let data = await this.invokeSelf(filepath, {
      originPath: filepath
    });
    return data.filepath;
  }
  /**
   * parse html tag start
   */
  parseHtmlTagStart(token){
    let list = [htmlTagResourceAttrs, this.options.tagAttrs || {}];
    let {attrs, tagLowerCase} = token.ext;
    let promises = list.map(item => {
      let tagAttrs = item[tagLowerCase] || [];
      if(!Array.isArray(tagAttrs)){
        tagAttrs = [tagAttrs];
      }
      let promise = tagAttrs.map(attr => {
        let value = this.stc.flkit.getHtmlAttrValue(attrs, attr);
        if(!value || isRemoteUrl(value)){
          return;
        }

        // <img src="/static/img/404.jpg" srcset="/static/img/404.jpg 640w 1x, /static/img/404.jpg 2x" />
        if(attr === 'srcset'){
          let values = value.split(',');
          let promises = values.map(item => {
            item = item.trim();
            let items = item.split(' ');
            return this.getUrlByInvoke(items[0].trim()).then(cdnUrl => {
              items[0] = cdnUrl;
              return items.join(' ');
            });
          });
          return Promise.all(promises).then(ret => {
            this.stc.flkit.setHtmlAttrValue(attrs, attr, ret.join(','));
          });
        }

        let extname = path.extname(value);
        // check link resource extname
        // ignore resource when has template syntax
        if(!/^\.\w+$/.test(extname)){
          return;
        }

        return this.getUrlByInvoke(value).then(cdnUrl => {
          this.stc.flkit.setHtmlAttrValue(attrs, attr, cdnUrl);
        });
      });

      // replace image/font in style value
      let stylePromise;
      let value = this.stc.flkit.getHtmlAttrValue(attrs, 'style');
      if(value){
        stylePromise = this.replaceCssResource(value).then(value => {
          this.stc.flkit.setHtmlAttrValue(attrs, 'style', value);
        });
      }
      return Promise.all([Promise.all(promise), stylePromise]);
    });
    return Promise.all(promises).then(() => {
      return token;
    });
  }
  /**
   * parse script tag
   */
  async parseHtmlTagScript(token){
    let start = token.ext.start;
    if(start.ext.isExternal){
      token.ext.start = await this.parseHtmlTagStart(start);
      return token;
    }
    let content = token.ext.content;
    content.value = await this.parseJsResource(content.value);
    return token;
  }
  /**
   * parse style tag
   */
  async parseHtmlTagStyle(token){
    let content = token.ext.content;
    let tokens = content.ext.tokens || content.value;
    let filepath = md5(content.value) + '.css';
    let file = await this.addFile(filepath, tokens, true);
    let ret = await this.invokeSelf(file);
    content.ext.tokens = ret;
    return token;
  }
  /**
   * update
   */
  update(data){
    if(this.isTpl()){
      this.setAst(data.ast);
      return;
    }
    let extname = this.file.extname;
    switch(extname){
      case 'js':
        this.setContent(data.content);
        break;
      case 'css':
        this.setAst(data.ast);
        break;
    }
  }
  /**
   * invoke once
   */
  static once(){
    return false;
  }
  /**
   * default include
   */
  static include(){
    return {type: 'tpl'};
  }
  /**
   * use cluster
   */
  static cluster(){
    return false;
  }
  /**
   * close cache
   */
  static cache(){
    return false;
  }
}
