/* eslint brace-style: 0, operator-linebreak: 0 */
/* global CodeMirror exports parserlib CSSLint */
'use strict';

let styleId = null;
let dirty = {};       // only the actually dirty items here
const editors = [];     // array of all CodeMirror instances
let saveSizeOnClose;
let useHistoryBack;   // use browser history back when 'back to manage' is clicked

// direct & reverse mapping of @-moz-document keywords and internal property names
const propertyToCss = {urls: 'url', urlPrefixes: 'url-prefix', domains: 'domain', regexps: 'regexp'};
const CssToProperty = {'url': 'urls', 'url-prefix': 'urlPrefixes', 'domain': 'domains', 'regexp': 'regexps'};

// if background page hasn't been loaded yet, increase the chances it has before DOMContentLoaded
onBackgroundReady();

// make querySelectorAll enumeration code readable
['forEach', 'some', 'indexOf', 'map'].forEach(method => {
  NodeList.prototype[method] = Array.prototype[method];
});

// Chrome pre-34
Element.prototype.matches = Element.prototype.matches || Element.prototype.webkitMatchesSelector;

// Chrome pre-41 polyfill
Element.prototype.closest = Element.prototype.closest || function (selector) {
  let e;
  // eslint-disable-next-line no-empty
  for (e = this; e && !e.matches(selector); e = e.parentElement) {}
  return e;
};

// eslint-disable-next-line no-extend-native
Array.prototype.rotate = function (amount) { // negative amount == rotate left
  const r = this.slice(-amount, this.length);
  Array.prototype.push.apply(r, this.slice(0, this.length - r.length));
  return r;
};

// eslint-disable-next-line no-extend-native
Object.defineProperty(Array.prototype, 'last', {get: function () { return this[this.length - 1]; }});

// preload the theme so that CodeMirror can calculate its metrics in DOMContentLoaded->setupLivePrefs()
new MutationObserver((mutations, observer) => {
  const themeElement = document.getElementById('cm-theme');
  if (themeElement) {
    themeElement.href = prefs.get('editor.theme') === 'default' ? ''
      : 'vendor/codemirror/theme/' + prefs.get('editor.theme') + '.css';
    observer.disconnect();
  }
}).observe(document, {subtree: true, childList: true});

getCodeMirrorThemes();

// reroute handling to nearest editor when keypress resolves to one of these commands
const hotkeyRerouter = {
  commands: {
    save: true, jumpToLine: true, nextEditor: true, prevEditor: true,
    find: true, findNext: true, findPrev: true, replace: true, replaceAll: true,
    toggleStyle: true,
  },
  setState: enable => {
    setTimeout(() => {
      document[(enable ? 'add' : 'remove') + 'EventListener']('keydown', hotkeyRerouter.eventHandler);
    }, 0);
  },
  eventHandler: event => {
    const keyName = CodeMirror.keyName(event);
    if (
      CodeMirror.lookupKey(keyName, CodeMirror.getOption('keyMap'), handleCommand) === 'handled' ||
      CodeMirror.lookupKey(keyName, CodeMirror.defaults.extraKeys, handleCommand) === 'handled'
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
    function handleCommand(command) {
      if (hotkeyRerouter.commands[command] === true) {
        CodeMirror.commands[command](getEditorInSight(event.target));
        return true;
      }
    }
  }
};

function onChange(event) {
  const node = event.target;
  if ('savedValue' in node) {
    const currentValue = node.type === 'checkbox' ? node.checked : node.value;
    setCleanItem(node, node.savedValue === currentValue);
  } else {
    // the manually added section's applies-to is dirty only when the value is non-empty
    setCleanItem(node, node.localName !== 'input' || !node.value.trim());
    delete node.savedValue; // only valid when actually saved
  }
  updateTitle();
}

// Set .dirty on stylesheet contributors that have changed
function setDirtyClass(node, isDirty) {
  node.classList.toggle('dirty', isDirty);
}

function setCleanItem(node, isClean) {
  if (!node.id) {
    node.id = Date.now().toString(32).substr(-6);
  }

  if (isClean) {
    delete dirty[node.id];
    // code sections have .CodeMirror property
    if (node.CodeMirror) {
      node.savedValue = node.CodeMirror.changeGeneration();
    } else {
      node.savedValue = node.type === 'checkbox' ? node.checked : node.value;
    }
  } else {
    dirty[node.id] = true;
  }

  setDirtyClass(node, !isClean);
}

function isCleanGlobal() {
  const clean = Object.keys(dirty).length === 0;
  setDirtyClass(document.body, !clean);
    // let saveBtn = document.getElementById('save-button')
    // if (clean){
    //     //saveBtn.removeAttribute('disabled');
    // }else{
    //     //saveBtn.setAttribute('disabled', true);
    // }
  return clean;
}

function setCleanGlobal() {
  document.querySelectorAll('#header, #sections > div').forEach(setCleanSection);
  dirty = {}; // forget the dirty applies-to ids from a deleted section after the style was saved
}

function setCleanSection(section) {
  section.querySelectorAll('.style-contributor').forEach(node => { setCleanItem(node, true); });

  // #header section has no codemirror
  const cm = section.CodeMirror;
  if (cm) {
    section.savedValue = cm.changeGeneration();
    indicateCodeChange(cm);
  }
}

function initCodeMirror() {
  const CM = CodeMirror;
  const isWindowsOS = navigator.appVersion.indexOf('Windows') > 0;

  // CodeMirror miserably fails on keyMap='' so let's ensure it's not
  if (!prefs.get('editor.keyMap')) {
    prefs.reset('editor.keyMap');
  }

  // default option values
  Object.assign(CM.defaults, {
    mode: 'css',
    lineNumbers: true,
    lineWrapping: true,
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers'],
    matchBrackets: true,
    highlightSelectionMatches: {showToken: /[#.\-\w]/, annotateScrollbar: true},
    hintOptions: {},
    lint: {getAnnotations: CodeMirror.lint.css, delay: prefs.get('editor.lintDelay')},
    lintReportDelay: prefs.get('editor.lintReportDelay'),
    styleActiveLine: true,
    theme: 'default',
    keyMap: prefs.get('editor.keyMap'),
    extraKeys: { // independent of current keyMap
      'Alt-Enter': 'toggleStyle',
      'Alt-PageDown': 'nextEditor',
      'Alt-PageUp': 'prevEditor'
    }
  }, prefs.get('editor.options'));

  // additional commands
  CM.commands.jumpToLine = jumpToLine;
  CM.commands.nextEditor = cm => { nextPrevEditor(cm, 1); };
  CM.commands.prevEditor = cm => { nextPrevEditor(cm, -1); };
  CM.commands.save = save;
  CM.commands.blockComment = cm => {
    cm.blockComment(cm.getCursor('from'), cm.getCursor('to'), {fullLines: false});
  };
  CM.commands.toggleStyle = toggleStyle;

  // 'basic' keymap only has basic keys by design, so we skip it

  const extraKeysCommands = {};
  Object.keys(CM.defaults.extraKeys).forEach(key => {
    extraKeysCommands[CM.defaults.extraKeys[key]] = true;
  });
  if (!extraKeysCommands.jumpToLine) {
    CM.keyMap.sublime['Ctrl-G'] = 'jumpToLine';
    CM.keyMap.emacsy['Ctrl-G'] = 'jumpToLine';
    CM.keyMap.pcDefault['Ctrl-J'] = 'jumpToLine';
    CM.keyMap.macDefault['Cmd-J'] = 'jumpToLine';
  }
  if (!extraKeysCommands.autocomplete) {
    CM.keyMap.pcDefault['Ctrl-Space'] = 'autocomplete'; // will be used by 'sublime' on PC via fallthrough
    CM.keyMap.macDefault['Alt-Space'] = 'autocomplete'; // OSX uses Ctrl-Space and Cmd-Space for something else
    CM.keyMap.emacsy['Alt-/'] = 'autocomplete'; // copied from 'emacs' keymap
    // 'vim' and 'emacs' define their own autocomplete hotkeys
  }
  if (!extraKeysCommands.blockComment) {
    CM.keyMap.sublime['Shift-Ctrl-/'] = 'blockComment';
  }

  if (isWindowsOS) {
    // 'pcDefault' keymap on Windows should have F3/Shift-F3
    if (!extraKeysCommands.findNext) {
      CM.keyMap.pcDefault['F3'] = 'findNext';
    }
    if (!extraKeysCommands.findPrev) {
      CM.keyMap.pcDefault['Shift-F3'] = 'findPrev';
    }

    // try to remap non-interceptable Ctrl-(Shift-)N/T/W hotkeys
    ['N', 'T', 'W'].forEach(char => {
      [{from: 'Ctrl-', to: ['Alt-', 'Ctrl-Alt-']},
       {from: 'Shift-Ctrl-', to: ['Ctrl-Alt-', 'Shift-Ctrl-Alt-']} // Note: modifier order in CM is S-C-A
      ].forEach(remap => {
        const oldKey = remap.from + char;
        Object.keys(CM.keyMap).forEach(keyMapName => {
          const keyMap = CM.keyMap[keyMapName];
          const command = keyMap[oldKey];
          if (!command) {
            return;
          }
          remap.to.some(newMod => {
            const newKey = newMod + char;
            if (!(newKey in keyMap)) {
              delete keyMap[oldKey];
              keyMap[newKey] = command;
              return true;
            }
          });
        });
      });
    });
  }

  // user option values
  CM.getOption = o => CodeMirror.defaults[o];
  CM.setOption = (o, v) => {
    CodeMirror.defaults[o] = v;
    editors.forEach(editor => {
      editor.setOption(o, v);
    });
  };

  CM.prototype.getSection = function () {
    return this.display.wrapper.parentNode;
  };

  // initialize global editor controls
  function optionsHtmlFromArray(options) {
    return options.map(opt => '<option>' + opt + '</option>').join('');
  }
  const themeControl = document.getElementById('editor.theme');
  const themeList = localStorage.codeMirrorThemes;
  if (themeList) {
    themeControl.innerHTML = optionsHtmlFromArray(themeList.split(/\s+/));
  } else {
    // Chrome is starting up and shows our edit.html, but the background page isn't loaded yet
    const theme = prefs.get('editor.theme');
    themeControl.innerHTML = optionsHtmlFromArray([theme === 'default' ? t('defaultTheme') : theme]);
    getCodeMirrorThemes().then(() => {
      const themes = (localStorage.codeMirrorThemes || '').split(/\s+/);
      themeControl.innerHTML = optionsHtmlFromArray(themes);
      themeControl.selectedIndex = Math.max(0, themes.indexOf(theme));
    });
  }
  document.getElementById('editor.keyMap').innerHTML = optionsHtmlFromArray(Object.keys(CM.keyMap).sort());
  document.getElementById('options').addEventListener('change', acmeEventListener, false);
  setupLivePrefs();

  hotkeyRerouter.setState(true);
}

function acmeEventListener(event) {
  const el = event.target;
  const option = el.id.replace(/^editor\./, '');
  //console.log('acmeEventListener heard %s on %s', event.type, el.id);
  if (!option) {
    console.error('acmeEventListener: no "cm_option" %O', el);
    return;
  }
  let value = el.type === 'checkbox' ? el.checked : el.value;
  switch (option) {
    case 'tabSize':
      CodeMirror.setOption('indentUnit', Number(value));
      break;
    case 'theme': {
      const themeLink = document.getElementById('cm-theme');
      // use non-localized 'default' internally
      if (!value || value === 'default' || value === t('defaultTheme')) {
        value = 'default';
        if (prefs.get(el.id) !== value) {
          prefs.set(el.id, value);
        }
        themeLink.href = '';
        el.selectedIndex = 0;
        break;
      }
      const url = chrome.runtime.getURL('vendor/codemirror/theme/' + value + '.css');
      if (themeLink.href === url) { // preloaded in initCodeMirror()
        break;
      }
      // avoid flicker: wait for the second stylesheet to load, then apply the theme
      document.head.insertAdjacentHTML('beforeend',
        '<link id="cm-theme2" rel="stylesheet" href="' + url + '">');
      (() => {
        setTimeout(() => {
          CodeMirror.setOption(option, value);
          themeLink.remove();
          document.getElementById('cm-theme2').id = 'cm-theme';
        }, 100);
      })();
      return;
    }
    case 'autocompleteOnTyping':
      editors.forEach(cm => {
        const onOff = el.checked ? 'on' : 'off';
        cm[onOff]('change', autocompleteOnTyping);
        cm[onOff]('pick', autocompletePicked);
      });
      return;
    case 'matchHighlight':
      switch (value) {
        case 'token':
        case 'selection':
          document.body.dataset[option] = value;
          value = {showToken: value === 'token' && /[#.\-\w]/, annotateScrollbar: true};
          break;
        default:
          value = null;
      }
  }
  CodeMirror.setOption(option, value);
}

// replace given textarea with the CodeMirror editor
function setupCodeMirror(textarea, index) {
  const cm = CodeMirror.fromTextArea(textarea, {lint: null});
  const wrapper = cm.display.wrapper;

  cm.on('change', indicateCodeChange);
  if (prefs.get('editor.autocompleteOnTyping')) {
    cm.on('change', autocompleteOnTyping);
    cm.on('pick', autocompletePicked);
  }
  cm.on('blur', () => {
    editors.lastActive = cm;
    hotkeyRerouter.setState(true);
    setTimeout(() => {
      wrapper.classList.toggle('CodeMirror-active', wrapper.contains(document.activeElement));
    });
  });
  cm.on('focus', () => {
    hotkeyRerouter.setState(false);
    wrapper.classList.add('CodeMirror-active');
  });
  cm.on('mousedown', (cm, event) => toggleContextMenuDelete.call(cm, event));

  let lastClickTime = 0;
  const resizeGrip = wrapper.appendChild(template.resizeGrip.cloneNode(true));
  resizeGrip.onmousedown = event => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (Date.now() - lastClickTime < 500) {
      lastClickTime = 0;
      toggleSectionHeight(cm);
      return;
    }
    lastClickTime = Date.now();
    const minHeight = cm.defaultTextHeight() +
      cm.display.lineDiv.offsetParent.offsetTop + /* .CodeMirror-lines padding */
      wrapper.offsetHeight - wrapper.clientHeight; /* borders */
    wrapper.style.pointerEvents = 'none';
    document.body.style.cursor = 's-resize';
    function resize(e) {
      const cmPageY = wrapper.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(minHeight, e.pageY - cmPageY);
      if (height !== wrapper.clientHeight) {
        cm.setSize(null, height);
      }
    }
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', function resizeStop() {
      document.removeEventListener('mouseup', resizeStop);
      document.removeEventListener('mousemove', resize);
      wrapper.style.pointerEvents = '';
      document.body.style.cursor = '';
    });
  };

  editors.splice(index || editors.length, 0, cm);
  return cm;
}

function indicateCodeChange(cm) {
  const section = cm.getSection();
  setCleanItem(section, cm.isClean(section.savedValue));
  updateTitle();
  updateLintReport(cm);
}

function getSectionForChild(e) {
  return e.closest('#sections > div');
}

function getSections() {
  return document.querySelectorAll('#sections > div');
}

// remind Chrome to repaint a previously invisible editor box by toggling any element's transform
// this bug is present in some versions of Chrome (v37-40 or something)
document.addEventListener('scroll', () => {
  const style = document.getElementById('name').style;
  style.webkitTransform = style.webkitTransform ? '' : 'scale(1)';
});

// Shift-Ctrl-Wheel scrolls entire page even when mouse is over a code editor
document.addEventListener('wheel', event => {
  if (event.shiftKey && event.ctrlKey && !event.altKey && !event.metaKey) {
    // Chrome scrolls horizontally when Shift is pressed but on some PCs this might be different
    window.scrollBy(0, event.deltaX || event.deltaY);
    event.preventDefault();
  }
});

queryTabs({currentWindow: true}).then(tabs => {
  const windowId = tabs[0].windowId;
  if (prefs.get('openEditInWindow')) {
    if (
      sessionStorage.saveSizeOnClose &&
      'left' in prefs.get('windowPosition', {}) &&
      !isWindowMaximized()
    ) {
      // window was reopened via Ctrl-Shift-T etc.
      chrome.windows.update(windowId, prefs.get('windowPosition'));
    }
    if (tabs.length === 1 && window.history.length === 1) {
      chrome.windows.getAll(windows => {
        if (windows.length > 1) {
          sessionStorageHash('saveSizeOnClose').set(windowId, true);
          saveSizeOnClose = true;
        }
      });
    } else {
      saveSizeOnClose = sessionStorageHash('saveSizeOnClose').value[windowId];
    }
  }
  chrome.tabs.onRemoved.addListener((tabId, info) => {
    sessionStorageHash('manageStylesHistory').unset(tabId);
    if (info.windowId === windowId && info.isWindowClosing) {
      sessionStorageHash('saveSizeOnClose').unset(windowId);
    }
  });
});

getActiveTab().then(tab => {
  useHistoryBack = sessionStorageHash('manageStylesHistory').value[tab.id] === location.href;
});

function goBackToManage(event) {
  if (useHistoryBack) {
    event.stopPropagation();
    event.preventDefault();
    history.back();
  } else if (styleId) {
    sessionStorage.justEditedStyleId = styleId;
  }
}

function isWindowMaximized() {
  return window.screenLeft === 0 &&
    window.screenTop === 0 &&
    window.outerWidth === screen.availWidth &&
    window.outerHeight === screen.availHeight;
}

window.onbeforeunload = () => {
  if (saveSizeOnClose && !isWindowMaximized()) {
    prefs.set('windowPosition', {
      left: screenLeft,
      top: screenTop,
      width: outerWidth,
      height: outerHeight
    });
  }
  document.activeElement.blur();
  if (isCleanGlobal()) {
    return;
  }
  updateLintReport(null, 0);
  return confirm(t('styleChangesNotSaved'));
};

function addAppliesTo(list, name, value) {
  const showingEverything = list.querySelector('.applies-to-everything') !== null;
  // blow away 'Everything' if it's there
  if (showingEverything) {
    list.removeChild(list.firstChild);
  }
  let e;
  if (name && value) {
    e = template.appliesTo.cloneNode(true);
    e.querySelector('[name=applies-type]').value = name;
    e.querySelector('[name=applies-value]').value = value;
    e.querySelector('.remove-applies-to').addEventListener('click', removeAppliesTo, false);
  } else if (showingEverything || list.hasChildNodes()) {
    e = template.appliesTo.cloneNode(true);
    if (list.hasChildNodes()) {
      e.querySelector('[name=applies-type]').value = list.querySelector('li:last-child [name="applies-type"]').value;
    }
    e.querySelector('.remove-applies-to').addEventListener('click', removeAppliesTo, false);
  } else {
    e = template.appliesToEverything.cloneNode(true);
  }
  e.querySelector('.add-applies-to').addEventListener('click', function () {
    addAppliesTo(this.parentNode.parentNode);
  }, false);
  list.appendChild(e);
}

function addSection(event, section) {
  const div = template.section.cloneNode(true);
  div.querySelector('.applies-to-help').addEventListener('click', showAppliesToHelp, false);
  div.querySelector('.remove-section').addEventListener('click', removeSection, false);
  div.querySelector('.add-section').addEventListener('click', addSection, false);
  div.querySelector('.beautify-section').addEventListener('click', beautify);

  const codeElement = div.querySelector('.code');
  const appliesTo = div.querySelector('.applies-to-list');
  let appliesToAdded = false;

  if (section) {
    codeElement.value = section.code;
    for (const i in propertyToCss) {
      if (section[i]) {
        section[i].forEach(url => {
          addAppliesTo(appliesTo, propertyToCss[i], url);
          appliesToAdded = true;
        });
      }
    }
  }
  if (!appliesToAdded) {
    addAppliesTo(appliesTo);
  }

  appliesTo.addEventListener('change', onChange);
  appliesTo.addEventListener('input', onChange);

  toggleTestRegExpVisibility();
  appliesTo.addEventListener('change', toggleTestRegExpVisibility);
  div.querySelector('.test-regexp').onclick = showRegExpTester;
  function toggleTestRegExpVisibility() {
    const show = [...appliesTo.children].some(item =>
      !item.matches('.applies-to-everything') &&
      item.querySelector('.applies-type').value === 'regexp' &&
      item.querySelector('.applies-value').value.trim());
    div.classList.toggle('has-regexp', show);
    appliesTo.oninput = appliesTo.oninput || show && (event => {
      if (
        event.target.matches('.applies-value') &&
        event.target.parentElement.querySelector('.applies-type').value === 'regexp'
      ) {
        showRegExpTester(null, div);
      }
    });
  }

  const sections = document.getElementById('sections');
  let cm;
  if (event) {
    const clickedSection = getSectionForChild(event.target);
    sections.insertBefore(div, clickedSection.nextElementSibling);
    const newIndex = getSections().indexOf(clickedSection) + 1;
    cm = setupCodeMirror(codeElement, newIndex);
    makeSectionVisible(cm);
    cm.focus();
    renderLintReport();
  } else {
    sections.appendChild(div);
    cm = setupCodeMirror(codeElement);
  }

  div.CodeMirror = cm;
  setCleanSection(div);
  return div;
}

function removeAppliesTo(event) {
  const appliesTo = event.target.parentNode;
  const appliesToList = appliesTo.parentNode;
  removeAreaAndSetDirty(appliesTo);
  if (!appliesToList.hasChildNodes()) {
    addAppliesTo(appliesToList);
  }
}

function removeSection(event) {
  const section = getSectionForChild(event.target);
  const cm = section.CodeMirror;
  removeAreaAndSetDirty(section);
  editors.splice(editors.indexOf(cm), 1);
  renderLintReport();
}

function removeAreaAndSetDirty(area) {
  const contributors = area.querySelectorAll('.style-contributor');
  if (!contributors.length) {
    setCleanItem(area, false);
  }
  contributors.some(node => {
    if (node.savedValue) {
      // it's a saved section, so make it dirty and stop the enumeration
      setCleanItem(area, false);
      return true;
    } else {
      // it's an empty section, so undirty the applies-to items,
      // otherwise orphaned ids would keep the style dirty
      setCleanItem(node, true);
    }
  });
  updateTitle();
  area.parentNode.removeChild(area);
}

function makeSectionVisible(cm) {
  const section = cm.getSection();
  const bounds = section.getBoundingClientRect();
  if (
    (bounds.bottom > window.innerHeight && bounds.top > 0) ||
    (bounds.top < 0 && bounds.bottom < window.innerHeight)
  ) {
    if (bounds.top < 0) {
      window.scrollBy(0, bounds.top - 1);
    } else {
      window.scrollBy(0, bounds.bottom - window.innerHeight + 1);
    }
  }
}

function setupGlobalSearch() {
  const originalCommand = {
    find: CodeMirror.commands.find,
    findNext: CodeMirror.commands.findNext,
    findPrev: CodeMirror.commands.findPrev,
    replace: CodeMirror.commands.replace
  };
  const originalOpenDialog = CodeMirror.prototype.openDialog;
  const originalOpenConfirm = CodeMirror.prototype.openConfirm;

  let curState; // cm.state.search for last used 'find'

  function shouldIgnoreCase(query) { // treat all-lowercase non-regexp queries as case-insensitive
    return typeof query === 'string' && query === query.toLowerCase();
  }

  function updateState(cm, newState) {
    if (!newState) {
      if (cm.state.search) {
        return cm.state.search;
      }
      if (!curState) {
        return null;
      }
      newState = curState;
    }
    cm.state.search = {
      query: newState.query,
      overlay: newState.overlay,
      annotate: cm.showMatchesOnScrollbar(newState.query, shouldIgnoreCase(newState.query))
    };
    cm.addOverlay(newState.overlay);
    return cm.state.search;
  }

  // temporarily overrides the original openDialog with the provided template's innerHTML
  function customizeOpenDialog(cm, template, callback) {
    cm.openDialog = (tmpl, cb, opt) => {
      // invoke 'callback' and bind 'this' to the original callback
      originalOpenDialog.call(cm, template.innerHTML, callback.bind(cb), opt);
    };
    setTimeout(() => { cm.openDialog = originalOpenDialog; }, 0);
    refocusMinidialog(cm);
  }

  function focusClosestCM(activeCM) {
    editors.lastActive = activeCM;
    const cm = getEditorInSight();
    if (cm !== activeCM) {
      cm.focus();
    }
    return cm;
  }

  function find(activeCM) {
    activeCM = focusClosestCM(activeCM);
    customizeOpenDialog(activeCM, template.find, function (query) {
      this(query);
      curState = activeCM.state.search;
      if (editors.length === 1 || !curState.query) {
        return;
      }
      editors.forEach(cm => {
        if (cm !== activeCM) {
          cm.execCommand('clearSearch');
          updateState(cm, curState);
        }
      });
      if (CodeMirror.cmpPos(curState.posFrom, curState.posTo) === 0) {
        findNext(activeCM);
      }
    });
    originalCommand.find(activeCM);
  }

  function findNext(activeCM, reverse) {
    let state = updateState(activeCM);
    if (!state || !state.query) {
      find(activeCM);
      return;
    }
    let pos = activeCM.getCursor(reverse ? 'from' : 'to');
    activeCM.setSelection(activeCM.getCursor()); // clear the selection, don't move the cursor

    const rxQuery = typeof state.query === 'object'
      ? state.query : stringAsRegExp(state.query, shouldIgnoreCase(state.query) ? 'i' : '');

    if (
      document.activeElement &&
      document.activeElement.name === 'applies-value' &&
      searchAppliesTo(activeCM)
    ) {
      return;
    }
    let cm = activeCM;
    for (let i = 0; i < editors.length; i++) {
      state = updateState(cm);
      if (!cm.hasFocus()) {
        pos = reverse ? CodeMirror.Pos(cm.lastLine()) : CodeMirror.Pos(0, 0);
      }
      const searchCursor = cm.getSearchCursor(state.query, pos, shouldIgnoreCase(state.query));
      if (searchCursor.find(reverse)) {
        if (editors.length > 1) {
          makeSectionVisible(cm);
          cm.focus();
        }
        // speedup the original findNext
        state.posFrom = reverse ? searchCursor.to() : searchCursor.from();
        state.posTo = CodeMirror.Pos(state.posFrom.line, state.posFrom.ch);
        originalCommand[reverse ? 'findPrev' : 'findNext'](cm);
        return;
      } else if (!reverse && searchAppliesTo(cm)) {
        return;
      }
      cm = editors[(editors.indexOf(cm) + (reverse ? -1 + editors.length : 1)) % editors.length];
      if (reverse && searchAppliesTo(cm)) {
        return;
      }
    }
    // nothing found so far, so call the original search with wrap-around
    originalCommand[reverse ? 'findPrev' : 'findNext'](activeCM);

    function searchAppliesTo(cm) {
      let inputs = [].slice.call(cm.getSection().querySelectorAll('.applies-value'));
      if (reverse) {
        inputs = inputs.reverse();
      }
      inputs.splice(0, inputs.indexOf(document.activeElement) + 1);
      return inputs.some(input => {
        const match = rxQuery.exec(input.value);
        if (match) {
          input.focus();
          const end = match.index + match[0].length;
          // scroll selected part into view in long inputs,
          // works only outside of current event handlers chain, hence timeout=0
          setTimeout(() => {
            input.setSelectionRange(end, end);
            input.setSelectionRange(match.index, end);
          }, 0);
          return true;
        }
      });
    }
  }

  function findPrev(cm) {
    findNext(cm, true);
  }

  function replace(activeCM, all) {
    let queue;
    let query;
    let replacement;
    activeCM = focusClosestCM(activeCM);
    customizeOpenDialog(activeCM, template[all ? 'replaceAll' : 'replace'], txt => {
      query = txt;
      customizeOpenDialog(activeCM, template.replaceWith, txt => {
        replacement = txt;
        queue = editors.rotate(-editors.indexOf(activeCM));
        if (all) {
          editors.forEach(doReplace);
        } else {
          doReplace();
        }
      });
      this(query);
    });
    originalCommand.replace(activeCM, all);

    function doReplace() {
      const cm = queue.shift();
      if (!cm) {
        if (!all) {
          editors.lastActive.focus();
        }
        return;
      }
      // hide the first two dialogs (replace, replaceWith)
      cm.openDialog = (tmpl, callback) => {
        cm.openDialog = (tmpl, callback) => {
          cm.openDialog = originalOpenDialog;
          if (all) {
            callback(replacement);
          } else {
            doConfirm(cm);
            callback(replacement);
            if (!cm.getWrapperElement().querySelector('.CodeMirror-dialog')) {
              // no dialog == nothing found in the current CM, move to the next
              doReplace();
            }
          }
        };
        callback(query);
      };
      originalCommand.replace(cm, all);
    }
    function doConfirm(cm) {
      let wrapAround = false;
      const origPos = cm.getCursor();
      cm.openConfirm = function overrideConfirm(tmpl, callbacks, opt) {
        const ovrCallbacks = callbacks.map(callback => () => {
          makeSectionVisible(cm);
          cm.openConfirm = overrideConfirm;
          setTimeout(() => { cm.openConfirm = originalOpenConfirm; }, 0);

          const pos = cm.getCursor();
          callback();
          const cmp = CodeMirror.cmpPos(cm.getCursor(), pos);
          wrapAround |= cmp <= 0;

          const dlg = cm.getWrapperElement().querySelector('.CodeMirror-dialog');
          if (!dlg || cmp === 0 || wrapAround && CodeMirror.cmpPos(cm.getCursor(), origPos) >= 0) {
            if (dlg) {
              dlg.remove();
            }
            doReplace();
          }
        });
        originalOpenConfirm.call(cm, template.replaceConfirm.innerHTML, ovrCallbacks, opt);
      };
    }
  }

  function replaceAll(cm) {
    replace(cm, true);
  }

  CodeMirror.commands.find = find;
  CodeMirror.commands.findNext = findNext;
  CodeMirror.commands.findPrev = findPrev;
  CodeMirror.commands.replace = replace;
  CodeMirror.commands.replaceAll = replaceAll;
}

function jumpToLine(cm) {
  const cur = cm.getCursor();
  refocusMinidialog(cm);
  cm.openDialog(template.jumpToLine.innerHTML, str => {
    const m = str.match(/^\s*(\d+)(?:\s*:\s*(\d+))?\s*$/);
    if (m) {
      cm.setCursor(m[1] - 1, m[2] ? m[2] - 1 : cur.ch);
    }
  }, {value: cur.line + 1});
}

function toggleStyle() {
  $('#enabled').checked = !$('#enabled').checked;
  save();
}

function toggleSectionHeight(cm) {
  if (cm.state.toggleHeightSaved) {
    // restore previous size
    cm.setSize(null, cm.state.toggleHeightSaved);
    cm.state.toggleHeightSaved = 0;
  } else {
    // maximize
    const wrapper = cm.display.wrapper;
    const allBounds = $('#sections').getBoundingClientRect();
    const pageExtrasHeight = allBounds.top + window.scrollY +
      parseFloat(getComputedStyle($('#sections')).paddingBottom);
    const sectionExtrasHeight = cm.getSection().clientHeight - wrapper.offsetHeight;
    cm.state.toggleHeightSaved = wrapper.clientHeight;
    cm.setSize(null, window.innerHeight - sectionExtrasHeight - pageExtrasHeight);
    const bounds = cm.getSection().getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
      window.scrollBy(0, bounds.top);
    }
  }
}

function autocompleteOnTyping(cm, info, debounced) {
  if (
    cm.state.completionActive ||
    info.origin && !info.origin.includes('input') ||
    !info.text.last
  ) {
    return;
  }
  if (cm.state.autocompletePicked) {
    cm.state.autocompletePicked = false;
    return;
  }
  if (!debounced) {
    debounce(autocompleteOnTyping, 100, cm, info, true);
    return;
  }
  if (info.text.last.match(/[-\w!]+$/)) {
    cm.state.autocompletePicked = false;
    cm.options.hintOptions.completeSingle = false;
    cm.execCommand('autocomplete');
    setTimeout(() => {
      cm.options.hintOptions.completeSingle = true;
    });
  }
}

function autocompletePicked(cm) {
  cm.state.autocompletePicked = true;
}

function refocusMinidialog(cm) {
  const section = cm.getSection();
  if (!section.querySelector('.CodeMirror-dialog')) {
    return;
  }
  // close the currently opened minidialog
  cm.focus();
  // make sure to focus the input in newly opened minidialog
  setTimeout(() => {
    section.querySelector('.CodeMirror-dialog').focus();
  }, 0);
}

function nextPrevEditor(cm, direction) {
  cm = editors[(editors.indexOf(cm) + direction + editors.length) % editors.length];
  makeSectionVisible(cm);
  cm.focus();
}

function getEditorInSight(nearbyElement) {
  // priority: 1. associated CM for applies-to element 2. last active if visible 3. first visible
  let cm;
  if (nearbyElement && nearbyElement.className.indexOf('applies-') >= 0) {
    cm = getSectionForChild(nearbyElement).CodeMirror;
  } else {
    cm = editors.lastActive;
  }
  if (!cm || offscreenDistance(cm) > 0) {
    const sorted = editors
      .map((cm, index) => ({cm: cm, distance: offscreenDistance(cm), index: index}))
      .sort((a, b) => a.distance - b.distance || a.index - b.index);
    cm = sorted[0].cm;
    if (sorted[0].distance > 0) {
      makeSectionVisible(cm);
    }
  }
  return cm;

  function offscreenDistance(cm) {
    const LINES_VISIBLE = 2; // closest editor should have at least # lines visible
    const bounds = cm.getSection().getBoundingClientRect();
    if (bounds.top < 0) {
      return -bounds.top;
    } else if (bounds.top < window.innerHeight - cm.defaultTextHeight() * LINES_VISIBLE) {
      return 0;
    } else {
      return bounds.top - bounds.height;
    }
  }
}

function updateLintReport(cm, delay) {
  if (delay === 0) {
    // immediately show pending csslint messages in onbeforeunload and save
    update(cm);
    return;
  }
  if (delay > 0) {
    setTimeout(cm => { cm.performLint(); update(cm); }, delay, cm);
    return;
  }
  // eslint-disable-next-line no-var
  var state = cm.state.lint;
  if (!state) {
    return;
  }
  // user is editing right now: postpone updating the report for the new issues (default: 500ms lint + 4500ms)
  // or update it as soon as possible (default: 500ms lint + 100ms) in case an existing issue was just fixed
  clearTimeout(state.reportTimeout);
  state.reportTimeout = setTimeout(update, state.options.delay + 100, cm);
  state.postponeNewIssues = delay === undefined || delay === null;

  function update(cm) {
    const scope = cm ? [cm] : editors;
    let changed = false;
    let fixedOldIssues = false;
    scope.forEach(cm => {
      const scopedState = cm.state.lint || {};
      const oldMarkers = scopedState.markedLast || {};
      const newMarkers = {};
      const html = !scopedState.marked || scopedState.marked.length === 0 ? '' : '<tbody>' +
        scopedState.marked.map(mark => {
          const info = mark.__annotation;
          const isActiveLine = info.from.line === cm.getCursor().line;
          const pos = isActiveLine ? 'cursor' : (info.from.line + ',' + info.from.ch);
          let message = escapeHtml(info.message.replace(/ at line \d.+$/, ''));
          if (message.length > 100) {
            message = message.substr(0, 100) + '...';
          }
          if (isActiveLine || oldMarkers[pos] === message) {
            delete oldMarkers[pos];
          }
          newMarkers[pos] = message;
          return '<tr class="' + info.severity + '">' +
            '<td role="severity" class="CodeMirror-lint-marker-' + info.severity + '">' +
              info.severity + '</td>' +
            '<td role="line">' + (info.from.line + 1) + '</td>' +
            '<td role="sep">:</td>' +
            '<td role="col">' + (info.from.ch + 1) + '</td>' +
            '<td role="message">' + message + '</td></tr>';
        }).join('') + '</tbody>';
      scopedState.markedLast = newMarkers;
      fixedOldIssues |= scopedState.reportDisplayed && Object.keys(oldMarkers).length > 0;
      if (scopedState.html !== html) {
        scopedState.html = html;
        changed = true;
      }
    });
    if (changed) {
      clearTimeout(state ? state.renderTimeout : undefined);
      if (!state || !state.postponeNewIssues || fixedOldIssues) {
        renderLintReport(true);
      } else {
        state.renderTimeout = setTimeout(() => {
          renderLintReport(true);
        }, CodeMirror.defaults.lintReportDelay);
      }
    }
  }
  function escapeHtml(html) {
    const chars = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;'};
    return html.replace(/[&<>"'/]/g, char => chars[char]);
  }
}

function renderLintReport(someBlockChanged) {
  const container = document.getElementById('lint');
  const content = container.children[1];
  const label = t('sectionCode');
  const newContent = content.cloneNode(false);
  let issueCount = 0;
  editors.forEach((cm, index) => {
    if (cm.state.lint && cm.state.lint.html) {
      const newBlock = newContent.appendChild(document.createElement('table'));
      const html = '<caption>' + label + ' ' + (index + 1) + '</caption>' + cm.state.lint.html;
      newBlock.innerHTML = html;
      newBlock.cm = cm;
      issueCount += newBlock.rows.length;

      const block = content.children[newContent.children.length - 1];
      const blockChanged = !block || cm !== block.cm || html !== block.innerHTML;
      someBlockChanged |= blockChanged;
      cm.state.lint.reportDisplayed = blockChanged;
    }
  });
  if (someBlockChanged || newContent.children.length !== content.children.length) {
    document.getElementById('issue-count').textContent = issueCount;
    container.replaceChild(newContent, content);
    container.style.display = newContent.children.length ? 'block' : 'none';
    resizeLintReport(null, newContent);
  }
}

function resizeLintReport(event, content) {
  content = content || document.getElementById('lint').children[1];
  if (content.children.length) {
    const bounds = content.getBoundingClientRect();
    const newMaxHeight = bounds.bottom <= innerHeight ? '' : (innerHeight - bounds.top) + 'px';
    if (newMaxHeight !== content.style.maxHeight) {
      content.style.maxHeight = newMaxHeight;
    }
  }
}

function gotoLintIssue(event) {
  const issue = event.target.closest('tr');
  if (!issue) {
    return;
  }
  const block = issue.closest('table');
  makeSectionVisible(block.cm);
  block.cm.focus();
  block.cm.setSelection({
    line: parseInt(issue.querySelector('td[role="line"]').textContent) - 1,
    ch: parseInt(issue.querySelector('td[role="col"]').textContent) - 1
  });
}

function toggleLintReport() {
  document.getElementById('lint').classList.toggle('collapsed');
}

function beautify(event) {
  if (exports.css_beautify) { // thanks to csslint's definition of 'exports'
    doBeautify();
  } else {
    const script = document.head.appendChild(document.createElement('script'));
    script.src = 'vendor-overwrites/beautify/beautify-css-mod.js';
    script.onload = doBeautify;
  }
  function doBeautify() {
    const tabs = prefs.get('editor.indentWithTabs');
    const options = prefs.get('editor.beautify');
    options.indent_size = tabs ? 1 : prefs.get('editor.tabSize');
    options.indent_char = tabs ? '\t' : ' ';

    const section = getSectionForChild(event.target);
    const scope = section ? [section.CodeMirror] : editors;

    showHelp(t('styleBeautify'), '<div class="beautify-options">' +
      optionHtml('.selector1,', 'selector_separator_newline') +
      optionHtml('.selector2,', 'newline_before_open_brace') +
      optionHtml('{', 'newline_after_open_brace') +
      optionHtml('border: none;', 'newline_between_properties', true) +
      optionHtml('display: block;', 'newline_before_close_brace', true) +
      optionHtml('}', 'newline_between_rules') +
      `<label style="display: block; clear: both;"><input data-option="indent_conditional" type="checkbox"
        ${options.indent_conditional !== false ? 'checked' : ''}>` +
        t('styleBeautifyIndentConditional') + '</label>' +
      '</div>' +
      '<div><button role="undo"></button></div>');

    const undoButton = document.querySelector('#help-popup button[role="undo"]');
    undoButton.textContent = t(scope.length === 1 ? 'undo' : 'undoGlobal');
    undoButton.addEventListener('click', () => {
      let undoable = false;
      scope.forEach(cm => {
        if (cm.beautifyChange && cm.beautifyChange[cm.changeGeneration()]) {
          delete cm.beautifyChange[cm.changeGeneration()];
          cm.undo();
          cm.scrollIntoView(cm.getCursor());
          undoable |= cm.beautifyChange[cm.changeGeneration()];
        }
      });
      undoButton.disabled = !undoable;
    });

    scope.forEach(cm => {
      setTimeout(() => {
        const pos = options.translate_positions =
          [].concat.apply([], cm.doc.sel.ranges.map(r =>
            [Object.assign({}, r.anchor), Object.assign({}, r.head)]));
        const text = cm.getValue();
        const newText = exports.css_beautify(text, options);
        if (newText !== text) {
          if (!cm.beautifyChange || !cm.beautifyChange[cm.changeGeneration()]) {
            // clear the list if last change wasn't a css-beautify
            cm.beautifyChange = {};
          }
          cm.setValue(newText);
          const selections = [];
          for (let i = 0; i < pos.length; i += 2) {
            selections.push({anchor: pos[i], head: pos[i + 1]});
          }
          cm.setSelections(selections);
          cm.beautifyChange[cm.changeGeneration()] = true;
          undoButton.disabled = false;
        }
      }, 0);
    });

    document.querySelector('.beautify-options').onchange = ({target}) => {
      const value = target.type === 'checkbox' ? target.checked : target.selectedIndex > 0;
      prefs.set('editor.beautify', Object.assign(options, {[target.dataset.option]: value}));
      if (target.parentNode.hasAttribute('newline')) {
        target.parentNode.setAttribute('newline', value.toString());
      }
      doBeautify();
    };

    function optionHtml(label, optionName, indent) {
      const value = options[optionName];
      return '<div newline="' + value.toString() + '">' +
        '<span' + (indent ? ' indent' : '') + '>' + label + '</span>' +
        '<select data-option="' + optionName + '">' +
          '<option' + (value ? '' : ' selected') + '>&nbsp;</option>' +
          '<option' + (value ? ' selected' : '') + '>\\n</option>' +
        '</select></div>';
    }
  }
}

document.addEventListener('DOMContentLoaded', init);

function init() {
  initCodeMirror();
  const params = getParams();
  if (!params.id) { // match should be 2 - one for the whole thing, one for the parentheses
    // This is an add
    tE('heading', 'addStyleTitle');
    const section = {code: ''};
    for (const i in CssToProperty) {
      if (params[i]) {
        section[CssToProperty[i]] = [params[i]];
      }
    }
    window.onload = () => {
      window.onload = null;
      addSection(null, section);
      editors[0].setOption('lint', CodeMirror.defaults.lint);
      // default to enabled
      document.getElementById('enabled').checked = true;
      initHooks();
    };
    return;
  }
  // This is an edit
  tE('heading', 'editStyleHeading', null, false);
  getStylesSafe({id: params.id}).then(styles => {
    let style = styles[0];
    if (!style) {
      style = {id: null, sections: []};
      history.replaceState({}, document.title, location.pathname);
    }
    styleId = style.id;
    setStyleMeta(style);
    window.onload = () => {
      window.onload = null;
      initWithStyle({style});
    };
    if (document.readyState !== 'loading') {
      window.onload();
    }
  });
}

function setStyleMeta(style) {
  document.getElementById('name').value = style.name;
  document.getElementById('enabled').checked = style.enabled;
  document.getElementById('url').href = style.url;
}

function initWithStyle({style, codeIsUpdated}) {
  setStyleMeta(style);

  if (codeIsUpdated === false) {
    setCleanGlobal();
    updateTitle();
    return;
  }

  // if this was done in response to an update, we need to clear existing sections
  getSections().forEach(div => { div.remove(); });
  const queue = style.sections.length ? style.sections.slice() : [{code: ''}];
  const queueStart = new Date().getTime();
  // after 100ms the sections will be added asynchronously
  while (new Date().getTime() - queueStart <= 100 && queue.length) {
    add();
  }
  (function processQueue() {
    if (queue.length) {
      add();
      setTimeout(processQueue, 0);
    }
  })();
  initHooks();

  function add() {
    const sectionDiv = addSection(null, queue.shift());
    maximizeCodeHeight(sectionDiv, !queue.length);
    const cm = sectionDiv.CodeMirror;
    setTimeout(() => {
      cm.setOption('lint', CodeMirror.defaults.lint);
      updateLintReport(cm, 0);
    }, prefs.get('editor.lintDelay'));
  }
}

function initHooks() {
  document.querySelectorAll('#header .style-contributor').forEach(node => {
    node.addEventListener('change', onChange);
    node.addEventListener('input', onChange);
  });
  document.getElementById('toggle-style-help').addEventListener('click', showToggleStyleHelp);
  document.getElementById('to-mozilla').addEventListener('click', showMozillaFormat, false);
  document.getElementById('to-mozilla-help').addEventListener('click', showToMozillaHelp, false);
  document.getElementById('from-mozilla').addEventListener('click', fromMozillaFormat);
  document.getElementById('beautify').addEventListener('click', beautify);
  document.getElementById('save-button').addEventListener('click', save, false);
  document.getElementById('sections-help').addEventListener('click', showSectionHelp, false);
  document.getElementById('keyMap-help').addEventListener('click', showKeyMapHelp, false);
  document.getElementById('cancel-button').addEventListener('click', goBackToManage);
  document.getElementById('lint-help').addEventListener('click', showLintHelp);
  document.getElementById('lint').addEventListener('click', gotoLintIssue);
  window.addEventListener('resize', resizeLintReport);

  // touch devices don't have onHover events so the element we'll be toggled via clicking (touching)
  if ('ontouchstart' in document.body) {
    document.querySelector('#lint h2').addEventListener('click', toggleLintReport);
  }

  document.querySelectorAll(
    'input:not([type]), input[type="text"], input[type="search"], input[type="number"]')
    .forEach(e => e.addEventListener('mousedown', toggleContextMenuDelete));

  setupGlobalSearch();
  setCleanGlobal();
  updateTitle();
}


function toggleContextMenuDelete(event) {
  if (event.button === 2 && prefs.get('editor.contextDelete')) {
    chrome.contextMenus.update('editor.contextDelete', {
      enabled: Boolean(
        this.selectionStart !== this.selectionEnd ||
        this.somethingSelected && this.somethingSelected()
      ),
    }, ignoreChromeError);
  }
}


function maximizeCodeHeight(sectionDiv, isLast) {
  const cm = sectionDiv.CodeMirror;
  const stats = maximizeCodeHeight.stats = maximizeCodeHeight.stats || {totalHeight: 0, deltas: []};
  if (!stats.cmActualHeight) {
    stats.cmActualHeight = getComputedHeight(cm.display.wrapper);
  }
  if (!stats.sectionMarginTop) {
    stats.sectionMarginTop = parseFloat(getComputedStyle(sectionDiv).marginTop);
  }
  const sectionTop = sectionDiv.getBoundingClientRect().top - stats.sectionMarginTop;
  if (!stats.firstSectionTop) {
    stats.firstSectionTop = sectionTop;
  }
  const extrasHeight = getComputedHeight(sectionDiv) - stats.cmActualHeight;
  const cmMaxHeight = window.innerHeight - extrasHeight - sectionTop - stats.sectionMarginTop;
  const cmDesiredHeight = cm.display.sizer.clientHeight + 2 * cm.defaultTextHeight();
  const cmGrantableHeight = Math.max(stats.cmActualHeight, Math.min(cmMaxHeight, cmDesiredHeight));
  stats.deltas.push(cmGrantableHeight - stats.cmActualHeight);
  stats.totalHeight += cmGrantableHeight + extrasHeight;
  if (!isLast) {
    return;
  }
  stats.totalHeight += stats.firstSectionTop;
  if (stats.totalHeight <= window.innerHeight) {
    editors.forEach((cm, index) => {
      cm.setSize(null, stats.deltas[index] + stats.cmActualHeight);
    });
    return;
  }
  // scale heights to fill the gap between last section and bottom edge of the window
  const sections = document.getElementById('sections');
  const available = window.innerHeight - sections.getBoundingClientRect().bottom -
    parseFloat(getComputedStyle(sections).marginBottom);
  if (available <= 0) {
    return;
  }
  const totalDelta = stats.deltas.reduce((sum, d) => sum + d, 0);
  const q = available / totalDelta;
  const baseHeight = stats.cmActualHeight - stats.sectionMarginTop;
  stats.deltas.forEach((delta, index) => {
    editors[index].setSize(null, baseHeight + Math.floor(q * delta));
  });
}

function updateTitle() {
  const DIRTY_TITLE = '* $';

  const name = document.getElementById('name').savedValue;
  const clean = isCleanGlobal();
  const title = styleId === null ? t('addStyleTitle') : t('editStyleTitle', [name]);
  document.title = clean ? title : DIRTY_TITLE.replace('$', title);
}

function validate() {
  const name = document.getElementById('name').value;
  if (name === '') {
    return t('styleMissingName');
  }
  // validate the regexps
  if (document.querySelectorAll('.applies-to-list').some(list => {
    list.childNodes.some(li => {
      if (li.className === template.appliesToEverything.className) {
        return false;
      }
      const valueElement = li.querySelector('[name=applies-value]');
      const type = li.querySelector('[name=applies-type]').value;
      const value = valueElement.value;
      if (type && value) {
        if (type === 'regexp') {
          try {
            new RegExp(value);
          } catch (ex) {
            valueElement.focus();
            return true;
          }
        }
      }
      return false;
    });
  })) {
    return t('styleBadRegexp');
  }
  return null;
}

function save() {
  updateLintReport(null, 0);

  // save the contents of the CodeMirror editors back into the textareas
  for (let i = 0; i < editors.length; i++) {
    editors[i].save();
  }

  const error = validate();
  if (error) {
    alert(error);
    return;
  }
  const name = document.getElementById('name').value;
  const enabled = document.getElementById('enabled').checked;
  saveStyleSafe({
    id: styleId,
    name: name,
    enabled: enabled,
    reason: 'editSave',
    sections: getSectionsHashes()
  })
    .then(saveComplete);
}

function getSectionsHashes() {
  const sections = [];
  getSections().forEach(div => {
    const meta = getMeta(div);
    const code = div.CodeMirror.getValue();
    if (/^\s*$/.test(code) && Object.keys(meta).length === 0) {
      return;
    }
    meta.code = code;
    sections.push(meta);
  });
  return sections;
}

function getMeta(e) {
  const meta = {urls: [], urlPrefixes: [], domains: [], regexps: []};
  e.querySelector('.applies-to-list').childNodes.forEach(li => {
    if (li.className === template.appliesToEverything.className) {
      return;
    }
    const type = li.querySelector('[name=applies-type]').value;
    const value = li.querySelector('[name=applies-value]').value;
    if (type && value) {
      const property = CssToProperty[type];
      meta[property].push(value);
    }
  });
  return meta;
}

function saveComplete(style) {
  styleId = style.id;
  setCleanGlobal();

  // Go from new style URL to edit style URL
  if (location.href.indexOf('id=') === -1) {
    history.replaceState({}, document.title, 'edit.html?id=' + style.id);
    tE('heading', 'editStyleHeading', null, false);
  }
  updateTitle();
}

function showMozillaFormat() {
  const popup = showCodeMirrorPopup(t('styleToMozillaFormatTitle'), '', {readOnly: true});
  popup.codebox.setValue(toMozillaFormat());
  popup.codebox.execCommand('selectAll');
}

function toMozillaFormat() {
  return getSectionsHashes().map(section => {
    let cssMds = [];
    for (const i in propertyToCss) {
      if (section[i]) {
        cssMds = cssMds.concat(section[i].map(v =>
          propertyToCss[i] + '("' + v.replace(/\\/g, '\\\\') + '")'
        ));
      }
    }
    return cssMds.length ? '@-moz-document ' + cssMds.join(', ') + ' {\n' + section.code + '\n}' : section.code;
  }).join('\n\n');
}

function fromMozillaFormat() {
  const popup = showCodeMirrorPopup(t('styleFromMozillaFormatPrompt'), tHTML(`<div>
      <button name="import-append" i18n-text="importAppendLabel" i18n-title="importAppendTooltip"></button>
      <button name="import-replace" i18n-text="importReplaceLabel" i18n-title="importReplaceTooltip"></button>
    </div>`
  ).innerHTML);

  const contents = popup.querySelector('.contents');
  contents.insertBefore(popup.codebox.display.wrapper, contents.firstElementChild);
  popup.codebox.focus();

  popup.querySelector('[name="import-append"]').addEventListener('click', doImport);
  popup.querySelector('[name="import-replace"]').addEventListener('click', doImport);

  popup.codebox.on('change', () => {
    clearTimeout(popup.mozillaTimeout);
    popup.mozillaTimeout = setTimeout(() => {
      popup.classList.toggle('ready', trimNewLines(popup.codebox.getValue()));
    }, 100);
  });

  function doImport() {
    const replaceOldStyle = this.name === 'import-replace';
    popup.querySelector('.dismiss').onclick();
    const mozStyle = trimNewLines(popup.codebox.getValue());
    const parser = new parserlib.css.Parser();
    const lines = mozStyle.split('\n');
    const sectionStack = [{code: '', start: {line: 1, col: 1}}];
    const errors = [];
    // let oldSectionCount = editors.length;
    let firstAddedCM;

    parser.addListener('startdocument', function (e) {
      let outerText = getRange(sectionStack.last.start, (--e.col, e));
      const gapComment = outerText.match(/(\/\*[\s\S]*?\*\/)[\s\n]*$/);
      const section = {code: '', start: backtrackTo(this, parserlib.css.Tokens.LBRACE, 'end')};
      // move last comment before @-moz-document inside the section
      if (gapComment && !gapComment[1].match(/\/\*\s*AGENT_SHEET\s*\*\//)) {
        section.code = gapComment[1] + '\n';
        outerText = trimNewLines(outerText.substring(0, gapComment.index));
      }
      if (outerText.trim()) {
        sectionStack.last.code = outerText;
        doAddSection(sectionStack.last);
        sectionStack.last.code = '';
      }
      for (const f of e.functions) {
        const m = f && f.match(/^([\w-]*)\((['"]?)(.+?)\2?\)$/);
        if (!m || !/^(url|url-prefix|domain|regexp)$/.test(m[1])) {
          errors.push(`${e.line}:${e.col + 1} invalid function "${m ? m[1] : f || ''}"`);
          continue;
        }
        const aType = CssToProperty[m[1]];
        const aValue = aType !== 'regexps' ? m[3] : m[3].replace(/\\\\/g, '\\');
        (section[aType] = section[aType] || []).push(aValue);
      }
      sectionStack.push(section);
    });

    parser.addListener('enddocument', function () {
      const end = backtrackTo(this, parserlib.css.Tokens.RBRACE, 'start');
      const section = sectionStack.pop();
      section.code += getRange(section.start, end);
      sectionStack.last.start = (++end.col, end);
      doAddSection(section);
    });

    parser.addListener('endstylesheet', () => {
      // add nonclosed outer sections (either broken or the last global one)
      const endOfText = {line: lines.length, col: lines.last.length + 1};
      sectionStack.last.code += getRange(sectionStack.last.start, endOfText);
      sectionStack.forEach(doAddSection);

      delete maximizeCodeHeight.stats;
      editors.forEach(cm => {
        maximizeCodeHeight(cm.getSection(), cm === editors.last);
      });

      makeSectionVisible(firstAddedCM);
      firstAddedCM.focus();

      if (errors) {
        showHelp(t('issues'), $element({
          tag: 'pre',
          textContent: errors.join('\n'),
        }));
      }
    });

    parser.addListener('error', e => {
      errors.push(e.line + ':' + e.col + ' ' +
        e.message.replace(/ at line \d.+$/, ''));
    });

    parser.parse(mozStyle);

    function getRange(start, end) {
      const L1 = start.line - 1;
      const C1 = start.col - 1;
      const L2 = end.line - 1;
      const C2 = end.col - 1;
      if (L1 === L2) {
        return lines[L1].substr(C1, C2 - C1 + 1);
      } else {
        const middle = lines.slice(L1 + 1, L2).join('\n');
        return lines[L1].substr(C1) + '\n' + middle +
          (L2 >= lines.length ? '' : ((middle ? '\n' : '') + lines[L2].substring(0, C2)));
      }
    }
    function doAddSection(section) {
      section.code = section.code.trim();
      // don't add empty sections
      if (
        !section.code &&
        !section.urls &&
        !section.urlPrefixes &&
        !section.domains &&
        !section.regexps
      ) {
        return;
      }
      if (!firstAddedCM) {
        if (!initFirstSection(section)) {
          return;
        }
      }
      setCleanItem(addSection(null, section), false);
      firstAddedCM = firstAddedCM || editors.last;
    }
    // do onetime housekeeping as the imported text is confirmed to be a valid style
    function initFirstSection(section) {
      // skip adding the first global section when there's no code/comments
      if (!section.code.replace('@namespace url(http://www.w3.org/1999/xhtml);', '') /* ignore boilerplate NS */
          .replace(/[\s\n]/g, '')) { /* ignore all whitespace including new lines */
        return false;
      }
      if (replaceOldStyle) {
        editors.slice(0).reverse().forEach(cm => {
          removeSection({target: cm.getSection().firstElementChild});
        });
      } else if (!editors.last.getValue()) {
        // nuke the last blank section
        if (editors.last.getSection().querySelector('.applies-to-everything')) {
          removeSection({target: editors.last.getSection()});
        }
      }
      return true;
    }
  }
  function backtrackTo(parser, tokenType, startEnd) {
    const tokens = parser._tokenStream._lt;
    for (let i = parser._tokenStream._ltIndex - 1; i >= 0; --i) {
      if (tokens[i].type === tokenType) {
        return {line: tokens[i][startEnd + 'Line'], col: tokens[i][startEnd + 'Col']};
      }
    }
  }
  function trimNewLines(s) {
    return s.replace(/^[\s\n]+/, '').replace(/[\s\n]+$/, '');
  }
}

function showSectionHelp() {
  showHelp(t('styleSectionsTitle'), t('sectionHelp'));
}

function showAppliesToHelp() {
  showHelp(t('appliesLabel'), t('appliesHelp'));
}

function showToMozillaHelp() {
  showHelp(t('styleMozillaFormatHeading'), t('styleToMozillaFormatHelp'));
}

function showToggleStyleHelp() {
  showHelp(t('helpAlt'), t('styleEnabledToggleHint'));
}

function showKeyMapHelp() {
  const keyMap = mergeKeyMaps({}, prefs.get('editor.keyMap'), CodeMirror.defaults.extraKeys);
  const keyMapSorted = Object.keys(keyMap)
    .map(key => ({key: key, cmd: keyMap[key]}))
    .concat([{key: 'Shift-Ctrl-Wheel', cmd: 'scrollWindow'}])
    .sort((a, b) => (a.cmd < b.cmd || (a.cmd === b.cmd && a.key < b.key) ? -1 : 1));
  showHelp(t('cm_keyMap') + ': ' + prefs.get('editor.keyMap'),
    '<table class="keymap-list">' +
      '<thead><tr><th><input placeholder="' + t('helpKeyMapHotkey') + '" type="search"></th>' +
        '<th><input placeholder="' + t('helpKeyMapCommand') + '" type="search"></th></tr></thead>' +
      '<tbody>' + keyMapSorted.map(value =>
        '<tr><td>' + value.key + '</td><td>' + value.cmd + '</td></tr>'
      ).join('') +
      '</tbody>' +
    '</table>');

  const table = document.querySelector('#help-popup table');
  table.addEventListener('input', filterTable);

  const inputs = table.querySelectorAll('input');
  inputs[0].addEventListener('keydown', hotkeyHandler);
  inputs[1].focus();

  function hotkeyHandler(event) {
    const keyName = CodeMirror.keyName(event);
    if (keyName === 'Esc' || keyName === 'Tab' || keyName === 'Shift-Tab') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // normalize order of modifiers,
    // for modifier-only keys ('Ctrl-Shift') a dummy main key has to be temporarily added
    const keyMap = {};
    keyMap[keyName.replace(/(Shift|Ctrl|Alt|Cmd)$/, '$&-dummy')] = '';
    const normalizedKey = Object.keys(CodeMirror.normalizeKeyMap(keyMap))[0];
    this.value = normalizedKey.replace('-dummy', '');
    filterTable(event);
  }

  function filterTable(event) {
    const input = event.target;
    const query = stringAsRegExp(input.value, 'gi');
    const col = input.parentNode.cellIndex;
    inputs[1 - col].value = '';
    table.tBodies[0].childNodes.forEach(row => {
      let cell = row.children[col];
      cell.innerHTML = cell.textContent.replace(query, '<mark>$&</mark>');
      row.style.display = query.test(cell.textContent) ? '' : 'none';
      // clear highlight from the other column
      cell = row.children[1 - col];
      cell.innerHTML = cell.textContent;
    });
  }
  function mergeKeyMaps(merged, ...more) {
    more.forEach(keyMap => {
      if (typeof keyMap === 'string') {
        keyMap = CodeMirror.keyMap[keyMap];
      }
      Object.keys(keyMap).forEach(key => {
        let cmd = keyMap[key];
        // filter out '...', 'attach', etc. (hotkeys start with an uppercase letter)
        if (!merged[key] && !key.match(/^[a-z]/) && cmd !== '...') {
          if (typeof cmd === 'function') {
            // for 'emacs' keymap: provide at least something meaningful (hotkeys and the function body)
            // for 'vim*' keymaps: almost nothing as it doesn't rely on CM keymap mechanism
            cmd = cmd.toString().replace(/^function.*?\{[\s\r\n]*([\s\S]+?)[\s\r\n]*\}$/, '$1');
            merged[key] = cmd.length <= 200 ? cmd : cmd.substr(0, 200) + '...';
          } else {
            merged[key] = cmd;
          }
        }
      });
      if (keyMap.fallthrough) {
        merged = mergeKeyMaps(merged, keyMap.fallthrough);
      }
    });
    return merged;
  }
}

function showLintHelp() {
  showHelp(t('issues'), t('issuesHelp') + '<ul>' +
    CSSLint.getRules().map(rule =>
      '<li><b>' + rule.name + '</b><br>' + rule.desc + '</li>'
    ).join('') + '</ul>'
  );
}

function showRegExpTester(event, section = getSectionForChild(this)) {
  const GET_FAVICON_URL = 'https://www.google.com/s2/favicons?domain=';
  const OWN_ICON = chrome.runtime.getManifest().icons['16'];
  const cachedRegexps = showRegExpTester.cachedRegexps =
    showRegExpTester.cachedRegexps || new Map();
  const regexps = [...section.querySelector('.applies-to-list').children]
    .map(item =>
      !item.matches('.applies-to-everything') &&
      item.querySelector('.applies-type').value === 'regexp' &&
      item.querySelector('.applies-value').value.trim())
    .filter(item => item)
    .map(text => {
      const rxData = Object.assign({text}, cachedRegexps.get(text));
      if (!rxData.urls) {
        cachedRegexps.set(text, Object.assign(rxData, {
          rx: tryRegExp(text),
          urls: new Map(),
        }));
      }
      return rxData;
    });
  chrome.tabs.onUpdated.addListener(function _(tabId, info) {
    if (document.querySelector('.regexp-report')) {
      if (info.url) {
        showRegExpTester(event, section);
      }
    } else {
      chrome.tabs.onUpdated.removeListener(_);
    }
  });
  queryTabs().then(tabs => {
    const supported = tabs.map(tab => tab.url)
      .filter(url => URLS.supported.test(url));
    const unique = [...new Set(supported).values()];
    for (const rxData of regexps) {
      const {rx, urls} = rxData;
      if (rx) {
        const urlsNow = new Map();
        for (const url of unique) {
          const match = urls.get(url) || (url.match(rx) || [])[0];
          if (match) {
            urlsNow.set(url, match);
          }
        }
        rxData.urls = urlsNow;
      }
    }
    const stats = {
      full: {data: [], label: t('styleRegexpTestFull')},
      partial: {data: [], label: [
        t('styleRegexpTestPartial'),
        template.regexpTestPartial.cloneNode(true),
      ]},
      none: {data: [], label: t('styleRegexpTestNone')},
      invalid: {data: [], label: t('styleRegexpTestInvalid')},
    };
    // collect stats
    for (const {text, rx, urls} of regexps) {
      if (!rx) {
        stats.invalid.data.push({text});
        continue;
      }
      if (!urls.size) {
        stats.none.data.push({text});
        continue;
      }
      const full = [];
      const partial = [];
      for (const [url, match] of urls.entries()) {
        const faviconUrl = url.startsWith(URLS.ownOrigin)
          ? OWN_ICON
          : GET_FAVICON_URL + new URL(url).hostname;
        const icon = $element({tag: 'img', src: faviconUrl});
        if (match.length === url.length) {
          full.push($element({appendChild: [
            icon,
            url,
          ]}));
        } else {
          partial.push($element({appendChild: [
            icon,
            $element({tag: 'mark', textContent: match}),
            url.substr(match.length),
          ]}));
        }
      }
      if (full.length) {
        stats.full.data.push({text, urls: full});
      }
      if (partial.length) {
        stats.partial.data.push({text, urls: partial});
      }
    }
    // render stats
    const report = $element({className: 'regexp-report'});
    const br = $element({tag: 'br'});
    for (const type in stats) {
      // top level groups: full, partial, none, invalid
      const {label, data} = stats[type];
      if (!data.length) {
        continue;
      }
      // 2nd level: regexp text
      const summary = $element({tag: 'summary', appendChild: label});
      const block = [summary];
      for (const {text, urls} of data) {
        if (!urls) {
          block.push(text, br.cloneNode());
          continue;
        }
        block.push($element({
          tag: 'details',
          open: true,
          appendChild: [
            $element({tag: 'summary', textContent: text}),
            // 3rd level: tab urls
            ...urls,
          ],
        }));
      }
      report.appendChild($element({
        tag: 'details',
        open: true,
        dataset: {type},
        appendChild: block,
      }));
    }
    showHelp(t('styleRegexpTestTitle'), report);

    document.querySelector('.regexp-report').onclick = event => {
      const target = event.target.closest('a, .regexp-report div');
      if (target) {
        openURL({url: target.href || target.textContent});
        event.preventDefault();
      }
    };
  });
}

function showHelp(title, text) {
  const div = $('#help-popup');
  div.classList.remove('big');

  const contents = $('.contents', div);
  if (text instanceof HTMLElement) {
    contents.textContent = '';
    contents.appendChild(text);
  } else {
    contents.innerHTML = text;
  }
  $('.title', div).textContent = title;

  if (getComputedStyle(div).display === 'none') {
    document.addEventListener('keydown', closeHelp);
    div.querySelector('.dismiss').onclick = closeHelp; // avoid chaining on multiple showHelp() calls
  }

  div.style.display = 'block';
  return div;

  function closeHelp(e) {
    if (
      !e ||
      e.type === 'click' ||
      ((e.keyCode || e.which) === 27 && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey)
    ) {
      div.style.display = '';
      document.querySelector('.contents').innerHTML = '';
      document.removeEventListener('keydown', closeHelp);
    }
  }
}

function showCodeMirrorPopup(title, html, options) {
  const popup = showHelp(title, html);
  popup.classList.add('big');

  popup.codebox = CodeMirror(popup.querySelector('.contents'), Object.assign({
    mode: 'css',
    lineNumbers: true,
    lineWrapping: true,
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers'],
    matchBrackets: true,
    lint: {getAnnotations: CodeMirror.lint.css, delay: 0},
    styleActiveLine: true,
    theme: prefs.get('editor.theme'),
    keyMap: prefs.get('editor.keyMap')
  }, options));
  popup.codebox.focus();
  popup.codebox.on('focus', () => { hotkeyRerouter.setState(false); });
  popup.codebox.on('blur', () => { hotkeyRerouter.setState(true); });
  return popup;
}

function getParams() {
  const params = {};
  const urlParts = location.href.split('?', 2);
  if (urlParts.length === 1) {
    return params;
  }
  urlParts[1].split('&').forEach(keyValue => {
    const splitKeyValue = keyValue.split('=', 2);
    params[decodeURIComponent(splitKeyValue[0])] = decodeURIComponent(splitKeyValue[1]);
  });
  return params;
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);

function onRuntimeMessage(request) {
  switch (request.method) {
    case 'styleUpdated':
      if (styleId && styleId === request.style.id && request.reason !== 'editSave') {
        if ((request.style.sections[0] || {}).code === null) {
          // the code-less style came from notifyAllTabs
          onBackgroundReady().then(() => {
            request.style = BG.cachedStyles.byId.get(request.style.id);
            initWithStyle(request);
          });
        } else {
          initWithStyle(request);
        }
      }
      break;
    case 'styleDeleted':
      if (styleId && styleId === request.id) {
        window.onbeforeunload = () => {};
        window.close();
        break;
      }
      break;
    case 'prefChanged':
      if ('editor.smartIndent' in request.prefs) {
        CodeMirror.setOption('smartIndent', request.prefs['editor.smartIndent']);
      }
      break;
    case 'editDeleteText':
      document.execCommand('delete');
      break;
  }
}

function getComputedHeight(el) {
  const compStyle = getComputedStyle(el);
  return el.getBoundingClientRect().height +
    parseFloat(compStyle.marginTop) + parseFloat(compStyle.marginBottom);
}


function getCodeMirrorThemes() {
  if (!chrome.runtime.getPackageDirectoryEntry) {
    const themes = [
      chrome.i18n.getMessage('defaultTheme'),
      '3024-day',
      '3024-night',
      'abcdef',
      'ambiance',
      'ambiance-mobile',
      'base16-dark',
      'base16-light',
      'bespin',
      'blackboard',
      'cobalt',
      'colorforth',
      'dracula',
      'duotone-dark',
      'duotone-light',
      'eclipse',
      'elegant',
      'erlang-dark',
      'hopscotch',
      'icecoder',
      'isotope',
      'lesser-dark',
      'liquibyte',
      'material',
      'mbo',
      'mdn-like',
      'midnight',
      'monokai',
      'neat',
      'neo',
      'night',
      'panda-syntax',
      'paraiso-dark',
      'paraiso-light',
      'pastel-on-dark',
      'railscasts',
      'rubyblue',
      'seti',
      'solarized',
      'the-matrix',
      'tomorrow-night-bright',
      'tomorrow-night-eighties',
      'ttcn',
      'twilight',
      'vibrant-ink',
      'xq-dark',
      'xq-light',
      'yeti',
      'zenburn',
    ];
    localStorage.codeMirrorThemes = themes.join(' ');
    return Promise.resolve(themes);
  }
  return new Promise(resolve => {
    chrome.runtime.getPackageDirectoryEntry(rootDir => {
      rootDir.getDirectory('vendor/codemirror/theme', {create: false}, themeDir => {
        themeDir.createReader().readEntries(entries => {
          const themes = [
            chrome.i18n.getMessage('defaultTheme')
          ].concat(
            entries.filter(entry => entry.isFile)
              .sort((a, b) => (a.name < b.name ? -1 : 1))
              .map(entry => entry.name.replace(/\.css$/, ''))
          );
          localStorage.codeMirrorThemes = themes.join(' ');
          resolve(themes);
        });
      });
    });
  });
}
