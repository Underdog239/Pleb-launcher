// In-memory instance tree — the local backend's DataModel.

import { classInfo, hasClass, propertiesFor, isA } from './reflection.js';

let nextId = 1;

export class Instance {
  /**
   * @param {string} className
   * @param {string} [name]
   */
  constructor(className, name = '') {
    this.id = nextId++;
    this.className = className;
    this.name = name || className;
    /** @type {Map<string, any>} */
    this.props = new Map();
    /** @type {Instance[]} */
    this.children = [];
    /** @type {Instance|null} */
    this.parent = null;
    this.isService = false;
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = value;
  }

  get(prop) {
    if (prop === 'Name') return this.name;
    if (prop === 'ClassName') return this.className;
    return this.props.get(prop);
  }

  set(prop, value) {
    if (prop === 'Name') {
      this.name = value;
      return;
    }
    if (prop === 'Parent') {
      this.setParent(value);
      return;
    }
    this.props.set(prop, value);
  }

  addChild(child) {
    child.setParent(this);
  }

  setParent(parent) {
    if (this.parent === parent) return;
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i !== -1) this.parent.children.splice(i, 1);
    }
    this.parent = parent;
    if (parent && !parent.children.includes(this)) parent.children.push(this);
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) {
      this.children.splice(i, 1);
      child.parent = null;
    }
  }

  findFirstChild(name) {
    return this.children.find((c) => c.name === name) || null;
  }

  /** Breadth-first descendants. */
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  isA(base) {
    return this.className === base || isA(this.className, base);
  }

  getFullName() {
    const parts = [];
    let cur = this;
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parent;
    }
    return parts.join('.');
  }
}

export function createInstance(className, name) {
  if (!hasClass(className)) {
    throw new Error(`unknown class: ${className}`);
  }
  return new Instance(className, name);
}

/** A root DataModel container holding top-level services/instances. */
export function createDataModel() {
  const dm = new Instance('DataModel', 'DataModel');
  return dm;
}

export { classInfo, propertiesFor };
