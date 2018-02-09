/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * undom.js
 */

// Prevent leaking global in functions with no callers.
'use strict';

// Chrome doesn't support ES6 modules in workers yet, so we dupe the flags
// on main page (renderer.js) and worker (undom.js).
const Flags = {
  REQUIRE_GESTURE_TO_MUTATE: false,
  USE_SHARED_ARRAY_BUFFER: false,
};

let initialRenderComplete = false;

// Variables in global scope are not enumerable and won't be dereferenced
// (which wouldn't work anyways).
// TODO(willchou): Figure out a way to avoid polluting the global scope with
// these variables/functions or define a naming convention for them.
let undom = function() {
  let observers = [];
  let pendingMutations = false;

  function assign(obj, props) {
    for (let i in props) { // eslint-disable-line guard-for-in
      obj[i] = props[i];
    }
  }

  function toLower(str) {
    return String(str).toLowerCase();
  }

  function createAttributeFilter(ns, name) {
    return (o) => o.ns === ns && toLower(o.name) === toLower(name);
  }

  function splice(arr, item, add, byValueOnly) {
    let i = arr ? findWhere(arr, item, true, byValueOnly) : -1;
    if (~i) {
      add
          ? arr.splice(i, 0, add)
          : arr.splice(i, 1);
    }
    return i;
  }

  function findWhere(arr, fn, returnIndex, byValueOnly) {
    let i = arr.length;
    while (i--) {
      if (typeof fn === 'function' && !byValueOnly
          ? fn(arr[i])
          : arr[i] === fn) {
        break;
      }
    }
    return returnIndex ? i : arr[i];
  }

  /**
   * Node.
   */
  class Node {
    constructor(nodeType, nodeName) {
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.childNodes = [];
      this.dirty = false;
    }
    /**
     * True if this property is defined by this class or any of its superclasses.
     * @returns {boolean}
     */
    propertyIsInherited(property) {
      return ['nodeType', 'nodeName', 'childNodes', 'parentNode'].indexOf(property) >= 0;
    }
    appendChild(child) {
      child.remove();
      child.parentNode = this;
      this.childNodes.push(child);
      if (this.children && child.nodeType === 1) {
        this.children.push(child);
      }
      mutation(this, 'childList', {addedNodes: [child], previousSibling: this.childNodes[this.childNodes.length - 2]});
    }
    firstChild() {
      // NOTE(willchou): Used by Preact for diffing DOM vs. VDOM children.
      return this.childNodes.length ? this.childNodes[0] : null;
    }
    insertBefore(child, ref) {
      child.remove();
      let i = splice(this.childNodes, ref, child), ref2;
      if (!ref) {
        this.appendChild(child);
      } else {
        if (~i && child.nodeType === 1) {
          while (i < this.childNodes.length && (ref2 = this.childNodes[i]).nodeType !== 1 || ref === child) {
            i++;
          }
          if (ref2) {
            splice(this.children, ref, child);
          }
        }
        mutation(this, 'childList', {addedNodes: [child], nextSibling: ref});
      }
    }
    replaceChild(child, ref) {
      if (ref.parentNode === this) {
        this.insertBefore(child, ref);
        ref.remove();
      }
    }
    removeChild(child) {
      let i = splice(this.childNodes, child);
      if (child.nodeType === 1) {
        splice(this.children, child);
      }
      mutation(this, 'childList', {removedNodes: [child], previousSibling: this.childNodes[i - 1], nextSibling: this.childNodes[i]});
    }
    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }
  }

  class Text extends Node {
    constructor(text) {
      super(3, '#text'); // TEXT_NODE
      this.data = text;
    }
    /** @override */
    propertyIsInherited(property) {
      return super.propertyIsInherited(property) || ['data'].indexOf(property) >= 0;
    }
    get textContent() {
      return this.data;
    }
    set textContent(value) {
      let oldValue = this.data;
      this.data = value;
      mutation(this, 'characterData', {value, oldValue});
    }
    get nodeValue() {
      return this.data;
    }
    set nodeValue(value) {
      this.textContent = value;
    }
  }

  class Element extends Node {
    constructor(nodeType, nodeName) {
      super(nodeType || 1, nodeName); // ELEMENT_NODE

      this.attributes = [];
      this.children = [];
      this.style = {};

      this.__handlers = {};

      Object.defineProperty(this, 'className', {
        set: (val) => {
          this.setAttribute('class', val);
        },
        get: () => this.getAttribute('style'),
      });
      Object.defineProperty(this.style, 'cssText', {
        set: (val) => {
          this.setAttribute('style', val);
        },
        get: () => this.getAttribute('style'),
      });
    }
    /** @override */
    propertyIsInherited(property) {
      return super.propertyIsInherited(property) || ['attributes', 'children', 'style'].indexOf(property) >= 0;
    }
    setAttribute(key, value) {
      this.setAttributeNS(null, key, value);
    }
    getAttribute(key) {
      return this.getAttributeNS(null, key);
    }
    removeAttribute(key) {
      this.removeAttributeNS(null, key);
    }
    setAttributeNS(ns, name, value) {
      let attr = findWhere(this.attributes, createAttributeFilter(ns, name)),
        oldValue = attr && attr.value;
      if (!attr) {
        this.attributes.push(attr = {ns, name});
      }
      attr.value = String(value);
      if (attr.value == oldValue) { // NOTE(willchou): Unclear why Preact is causing no-op diffs here.
        return;
      }
      mutation(this, 'attributes', {attributeName: name, attributeNamespace: ns, value: attr.value, oldValue});
    }
    getAttributeNS(ns, name) {
      let attr = findWhere(this.attributes, createAttributeFilter(ns, name));
      return attr && attr.value;
    }
    removeAttributeNS(ns, name) {
      if (!this.getAttributeNS(ns, name)) { // NOTE(willchou): Ditto re: above.
        return;
      }
      splice(this.attributes, createAttributeFilter(ns, name));
      mutation(this, 'attributes', {attributeName: name, attributeNamespace: ns, oldValue: this.getAttributeNS(ns, name)});
    }
    addEventListener(type, handler) {
      (this.__handlers[toLower(type)] || (this.__handlers[toLower(type)] = [])).push(handler);
    }
    removeEventListener(type, handler) {
      splice(this.__handlers[toLower(type)], handler, 0, true);
    }
    dispatchEvent(event) {
      let t = event.currentTarget = this,
        c = event.cancelable,
        l, i;
      do {
        l = t.__handlers && t.__handlers[toLower(event.type)];
        if (l) {
          for (i = l.length; i--; ) {
            if ((l[i].call(t, event) === false || event._end) && c) {
              break;
            }
          }
        }
      } while (event.bubbles && !(c && event._stop) && (event.target = t = t.parentNode));
      return !event.defaultPrevented;
    }
    // TODO(willchou): Actually belongs to HTMLInputElement. Put in proxy?
    get type() {
      if (this.nodeName == 'INPUT') {
        return this.getAttribute('type') || 'text';
      }
      return undefined;
    }
  }

  class SVGElement extends Element {}

  class Document extends Element {
    constructor() {
      super(9, '#document'); // DOCUMENT_NODE
    }
  }

  const PREACT_PROPS = {
    "_dirty": "__d",
    "_disable": "__x",
    "_listeners": "__l",
    "_renderCallbacks": "__h",
    "__key": "__k",
    "__ref": "__r",
    "normalizedNodeName": "__n",
    "nextBase": "__b",
    "prevContext": "__c",
    "prevProps": "__p",
    "prevState": "__s",
    "_parentComponent": "__u",
    "_componentConstructor": "_componentConstructor",
    "__html": "__html",
    "_component": "_component",
    "__preactattr_": "__preactattr_"
  };

  /**
   * @param {!Object} target
   * @param {*} value
   * @returns {boolean}
   */
  function isDOMProperty(target, value) {
    if (typeof value != 'string') { // Ignore symbols.
      return false;
    }
    if (value.startsWith('_') || value.endsWith('_')) { // Ignore private props.
      return false;
    }
    if (PREACT_PROPS[value]) { // TODO(willchou): Replace this with something better.
      return false;
    }
    if (!target.propertyIsEnumerable(value)) {
      return false;
    }
    if (target.propertyIsInherited(value)) { // Skip Node.nodeType etc.
      return false;
    }
    return true;
  }

  /**
   * Handler object that defines traps for proxying Element.
   * Used to observe property changes and trigger mutations from them.
   */
  const ElementProxyHandler = {
    set(target, property, value, receiver) {
      // Special-case for '**'-prefixed properties forwarded from page (rather
      // than mutated in the worker). We should skip triggering the mutation
      // observer since that would be a circular update.
      if (typeof property == 'string' && property.startsWith('**')) {
        target[property.substring(2)] = value;
        return true;
      }
      const oldValue = target[property];
      if (oldValue === value) {
        return true;
      }
      target[property] = value;
      if (isDOMProperty(target, property)) {
        // Update attribute on first render (mimic DOM behavior of props vs. attrs).
        if (!target.getAttribute(property)) {
          target.setAttribute(property, value);
        }
        mutation(target, 'properties', {propertyName: property, value, oldValue});
      }
      return true;
    },
    has(target, property) {
      // Necessary since Preact checks `in` before setting properties on elements.
      return isDOMProperty(target, property);
    }
  };

  class Event {
    constructor(type, opts) {
      this.type = type;
      this.bubbles = !!opts.bubbles;
      this.cancelable = !!opts.cancelable;
    }
    stopPropagation() {
      this._stop = true;
    }
    stopImmediatePropagation() {
      this._end = this._stop = true;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  }

  function mutation(target, type, record) {
    record.target = target.__id || target; // Use __id if available.
    record.type = type;

    if (Flags.USE_SHARED_ARRAY_BUFFER) {
      if (initialRenderComplete) {
        target.dirty = true;
        serializeDom();
        postMessage({type: 'dom-update'});
      }
      return;
    }

    for (let i = observers.length; i--; ) {
      let ob = observers[i];
      let match = target === ob._target;
      if (!match && ob._options.subtree) {
        do {
          if ((match = target === ob._target)) {
            break;
          }
        } while ((target = target.parentNode));
      }
      if (match) {
        ob._records.push(record);
        if (!pendingMutations) {
          pendingMutations = true;
          Promise.resolve().then(flushMutations);
        }
      }
    }
  }

  function flushMutations() {
    pendingMutations = false;
    for (let i = observers.length; i--; ) {
      let ob = observers[i];
      if (ob._records.length) {
        ob.callback(ob.takeRecords());
      }
    }
  }

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this._records = [];
    }
    observe(target, options) {
      this.disconnect();
      this._target = target;
      this._options = options || {};
      observers.push(this);
    }
    disconnect() {
      this._target = null;
      splice(observers, this);
    }
    takeRecords() {
      return this._records.splice(0, this._records.length);
    }
  }

  function createElement(type) {
    const t = String(type).toUpperCase();
    const element = new Element(null, t);
    if (Flags.USE_SHARED_ARRAY_BUFFER) {
      return element;
    } else {
      // Use proxy so we can observe and forward property changes e.g. HTMLInputElement.value.
      const proxy = new Proxy(element, ElementProxyHandler);
      return proxy;
    }
  }

  function createElementNS(ns, type) {
    let element = createElement(type);
    element.namespace = ns;
    return element;
  }

  function createTextNode(text) {
    return new Text(text);
  }

  function createDocument() {
    let document = new Document();
    assign(document, document.defaultView = {document, MutationObserver, Document, Node, Text, Element, SVGElement, Event});
    assign(document, {documentElement: document, createElement, createElementNS, createTextNode});
    document.appendChild(document.body = createElement('body'));
    return document;
  }

  return createDocument();
};

/*
 * monkey.js
 */

/**
 * Monkey-patch WorkerGlobalScope.
 */

const monkeyScope = {
  document: undom(),
  history: {
    pushState(a, b, url) {
      send({type: 'pushState', url});
    },
    replaceState(a, b, url) {
      send({type: 'replaceState', url});
    },
  },
  localStorage: {},
  location: {},
  url: '/',
};
// Surface top-level undom window properties e.g document, Element.
const undomWindow = monkeyScope.document.defaultView;
for (let i in undomWindow) {
  if (undomWindow.hasOwnProperty(i)) {
    monkeyScope[i] = undomWindow[i];
  }
}

/**
 * Worker communication layer.
 */

// Use an IIFE to "store" references to globals that we'll dereference from `self` below.
// This makes sure that (1) privileged functions like postMessage() can't be invoked by 3P JS
// and (2) we don't pollute the global scope with new variables/functions.
(function(__scope, __postMessage) {
  let NODE_COUNTER = 0;

  const TO_SANITIZE = ['addedNodes', 'removedNodes', 'nextSibling', 'previousSibling', 'target'];

  // TODO(willchou): Replace this with something more generic.
  const PROP_BLACKLIST = ['children', 'parentNode', '__handlers', '_component', '_componentConstructor'];

  const NODES = new Map();

  function getNode(node) {
    let id;
    if (node && typeof node === 'object') {
      id = node.__id;
    }
    if (typeof node === 'string') {
      id = node;
    }
    if (!id) {
      return null;
    }
    if (node.nodeName === 'BODY') {
      return __scope.document.body;
    }
    const n = NODES.get(id);
    return n;
  }

  function handleEvent(event) {
    if (event.type == 'hashchange') {
      const url = new URL(event.newURL);
      // Don't reassign location to avoid orphaning any old references.
      __scope.location.href = url.href;
      __scope.location.hash = url.hash;
      __scope.location.pathname = url.pathname;
      __scope.location.search = url.search;
      console.info('Updated location:', __scope.location);
    }

    // Null target may mean it was a window-level event e.g. 'hashchange'.
    // Dispatch those from the document instead. We also proxy invocations
    // of `addEventListener` on the global scope too. See entry.js.
    let target = getNode(event.target) || __scope.document;
    if (target) {
      // Update worker DOM with user changes to <input> etc.
      if ('__value' in event) {
        target['**value'] = event.__value;
      }
      event.target = target;
      event.bubbles = true;
      event.preventDefault = () => {
        console.info('preventDefault() called on: ', event);
      };
      target.dispatchEvent(event);
    }
  }

  function sanitize(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }

    if (obj instanceof __scope.document.defaultView.Node) {
      let id = obj.__id;
      if (!id) {
        id = obj.__id = String(++NODE_COUNTER);
      }
      NODES.set(id, obj);
    }

    let out = {};
    for (let i in obj) {
      if (obj.hasOwnProperty(i) && PROP_BLACKLIST.indexOf(i) < 0) {
        out[i] = obj[i];
      }
    }
    if (out.childNodes && out.childNodes.length) {
      out.childNodes = sanitize(out.childNodes);
    }
    return out;
  }

  if (!Flags.USE_SHARED_ARRAY_BUFFER) {
    const observer = new __scope.MutationObserver((mutations) => {
      for (let i = mutations.length; i--; ) {
        let mutation = mutations[i];
        for (let j = TO_SANITIZE.length; j--; ) {
          let prop = TO_SANITIZE[j];
          mutation[prop] = sanitize(mutation[prop]);
        }
      }
      send({type: 'mutate', mutations});
    });
    observer.observe(__scope.document, {subtree: true});
  }

  // For Flags.USE_SHARED_ARRAY_BUFFER.
  function serializeDom() {
    if (!sharedArray) {
      return;
    }
    const serialized = sanitize(__scope.document.body);
    const string = JSON.stringify(serialized);
    let l = string.length;
    for (let i = 0; i < l; i++) {
      Atomics.store(sharedArray, i, string.charCodeAt(i));
    }
    // Erase trailing bytes in case DOM has decreased in size.
    for (let i = string.length; i < sharedArray.length; i++) {
      if (Atomics.load(sharedArray, i) > 0) {
        Atomics.store(sharedArray, i, 0);
      } else {
        break;
      }
    }
  }

  // For Flags.USE_SHARED_ARRAY_BUFFER.
  function onInitialRender() {
    initialRenderComplete = true;
    serializeDom();
    __postMessage({type: 'init-render'});
  };

  function send(message) {
    const json = JSON.parse(JSON.stringify(message));
    json.timestamp = performance.now();
    __postMessage(json);
  }

  let sharedArray;

  addEventListener('message', ({data}) => {
    switch (data.type) {
      case 'init':
        __scope.url = data.url;

        if (Flags.USE_SHARED_ARRAY_BUFFER) {
          sharedArray = new Uint16Array(data.buffer);
          // HACK(willchou): Should instead wait until X ms after last DOM mutation.
          setTimeout(onInitialRender, 200);
        }
        break;
      case 'event':
        handleEvent(data.event);
        break;
    }
  });
})(monkeyScope, postMessage);

/**
 * Dereference non-whitelisted globals.
 */

// This is incomplete -- just grabbed the first ~50 properties on DedicatedGlobalWorkerScope object.
// TODO(willchou): Complete this list.
const WHITELISTED_GLOBALS = {
  'Object': true,
  'Function': true,
  'Array': true,
  'Number': true,
  'parseFloat': true,
  'parseInt': true,
  'Infinity': true,
  'NaN': true,
  'undefined': true,
  'Boolean': true,
  'String': true,
  'Symbol': true,
  'Date': true,
  'Promise': true,
  'RegExp': true,
  'Error': true,
  'EvalError': true,
  'RangeError': true,
  'ReferenceError': true,
  'SyntaxError': true,
  'TypeError': true,
  'URIError': true,
  'JSON': true,
  'Math': true,
  'console': true,
  'Intl': true,
  'ArrayBuffer': true,
  'Uint8Array': true,
  'Int8Array': true,
  'Uint16Array': true,
  'Int16Array': true,
  'Uint32Array': true,
  'Int32Array': true,
  'Float32Array': true,
  'Float64Array': true,
  'Uint8ClampedArray': true,
  'DataView': true,
  'Map': true,
  'Set': true,
  'WeakMap': true,
  'WeakSet': true,
  'Proxy': true,
  'Reflect': true,
  'decodeURI': true,
  'decodeURIComponent': true,
  'encodeURI': true,
  'encodeURIComponent': true,
  'escape': true,
  'unescape': true,
  'eval': true,
  'isFinite': true,
  'isNaN': true,
  // Later additions.
  'performance': true,
  'URL': true,
};
Object.keys(monkeyScope).forEach(monkeyProp => {
  WHITELISTED_GLOBALS[monkeyProp] = true;
});

// Delete non-whitelisted properties from global scope.
(function() {
  function deleteUnsafe(object, property) {
    if (WHITELISTED_GLOBALS[property]) {
      return;
    }
    // TODO(willchou): Instead of deleting, throw custom error at runtime?
    try {
      console.info(`Deleting "${property}"...`);
      delete object[property];
    } catch (e) {
      console.error(e);
    }
  }

  let current = self;
  while (current) {
    console.info('Removing unsafe references from:', current);
    Object.getOwnPropertyNames(current).forEach(prop => {
      deleteUnsafe(current, prop);
    });
    // getOwnPropertyNames() doesn't include inherited properties,
    // so manually walk up the prototype chain.
    current = Object.getPrototypeOf(current);
  }
})();

/*
 * entry.js
 */

(function() {

  // (function() {
  //   try {
  //     console.assert(!(Function("return this")())); // CSP should disallow this.
  //   } catch (e) {}
  //   try {
  //     console.assert(!((0, eval)("this"))); // CSP should disallow this.
  //   } catch (e) {}
  //   const f = (function() { return this })(); // Strict mode should disallow this.
  //   console.assert(!f);
  // })();

  const self = this;

  const document = this.document;
  const localStorage = this.localStorage;
  const location = this.location;

  // Proxy event listeners invoked on global.
  const addEventListener = (type, handler) => document.addEventListener(type, handler);

  const Node = this.Node;
  const Text = this.Text;
  const Element = this.Element;
  const SVGElement = this.SVGElement;
  const Document = this.Document;
  const Event = this.Event;
  const MutationObserver = this.MutationObserver;

  try { console.assert(!WorkerGlobalScope); } catch (e) {
    console.assert(e.message == 'WorkerGlobalScope is not defined');
  }
  try { console.assert(!DedicatedWorkerGlobalScope); } catch (e) {
    console.assert(e.message == 'DedicatedWorkerGlobalScope is not defined');
  }
  try { console.assert(!XmlHttpRequest); } catch (e) {
    console.assert(e.message == 'XmlHttpRequest is not defined');
  }

  // Inject app here! (IIFE intentonally left open)
