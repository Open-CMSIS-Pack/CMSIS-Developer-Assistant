/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
import { childrenOf, decodeEntities, parseXml } from '../core/packDocs/xmlLite';

suite('xmlLite', () => {
    test('parses elements, attributes, text, comments, CDATA and entities', () => {
        const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- header -->
<package xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" schemaVersion='1.7'>
  <name>STM32F7xx_DFP</name>
  <description>Board &amp; Device &lt;Family&gt; &#x41;&#66;</description>
  <devices>
    <family Dfamily="STM32F7 Series" Dvendor="STMicroelectronics:13">
      <book name="Documents/rm.pdf" title="Reference Manual"/>
      <subFamily DsubFamily="STM32F756">
        <device Dname="STM32F756ZG"><variant Dvariant="STM32F756ZGTx"/></device>
      </subFamily>
    </family>
  </devices>
  <notes><![CDATA[a < b && c]]></notes>
</package>`);
        assert.strictEqual(root.tag, 'package');
        assert.strictEqual(root.attrs.schemaVersion, '1.7');
        assert.strictEqual(childrenOf(root, 'name')[0].text, 'STM32F7xx_DFP');
        assert.strictEqual(childrenOf(root, 'description')[0].text, 'Board & Device <Family> AB');
        const family = childrenOf(childrenOf(root, 'devices')[0], 'family')[0];
        assert.strictEqual(family.attrs.Dfamily, 'STM32F7 Series');
        assert.strictEqual(childrenOf(family, 'book')[0].attrs.title, 'Reference Manual');
        const device = childrenOf(childrenOf(family, 'subFamily')[0], 'device')[0];
        assert.strictEqual(childrenOf(device, 'variant')[0].attrs.Dvariant, 'STM32F756ZGTx');
        assert.strictEqual(childrenOf(root, 'notes')[0].text, 'a < b && c');
    });

    test('rejects mismatched tags with the offset', () => {
        assert.throws(() => parseXml('<a><b></a>'), /closing <\/a> does not match <b>/);
    });

    test('decodeEntities leaves unknown entities alone', () => {
        assert.strictEqual(decodeEntities('x &nbsp; &amp;'), 'x &nbsp; &');
    });
});
