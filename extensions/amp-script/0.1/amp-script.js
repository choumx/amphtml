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

import {Services} from '../../../src/services';
import {isLayoutSizeDefined} from '../../../src/layout';
import renderer from './renderer';

export class AmpScript extends AMP.BaseElement {
  /** @override */
  isLayoutSupported(layout) {
    return true;
  }

  /** @override */
  layoutCallback() {
    return this.fetchText_(this.element.getAttribute('src'))
        .then(script => this.createWorker_(script));
  }

  /**
   * @param {string} script
   * @private
   */
  createWorker_(script) {
    // TODO(willchou): Output a second binary in amp-script extension folder instead.
    return this.fetchText_('/extensions/amp-script/0.1/worker.js').then(text => {
      const code = [text, script, '}).call(monkeyScope);'].join('\n');
      const blobUrl = URL.createObjectURL(
          new Blob([code], {type: 'text/javascript'}));
      renderer({win: this.win, worker: new Worker(blobUrl), root: this.element});
    });
  }

  /**
   * @param {string} url
   * @private
   */
  fetchText_(url) {
    return Services.xhrFor(this.win)
        .fetchText(url, {ampCors: false})
        .then(res => res.text());
  }
}

AMP.extension('amp-script', '0.1', function(AMP) {
  AMP.registerElement('amp-script', AmpScript);
});
