/**
 * Copyright (c) 2014, 2015 Tim Kuijsten
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

//derived from https://github.com/w9/node-bson-stream 

//const util = require('util');
const BSON = require('bson');
const Transform = require('stream').Transform;
const assert = require('assert');

/**
* BSONStream
*
* Read a binary stream that contains BSON objects and emit each as a JavaScript
* object (or as a Buffer if opts.raw is true).
*
* Note: implements BSON specification 1.0 (http://bsonspec.org/spec.html), as
* supported by js-bson (https://www.npmjs.org/package/bson).
*
* Note2: Buffer objects will be embedded in a new BSON Buffer object at `buffer`.
*/
class BSONStream extends Transform {
  /**
  * @param {Object} [opts] object containing optional parameters
  *
  * opts:
  * raw {Boolean, default false} whether to emit JavaScript objects or raw Buffers
  * maxDocLength {Number, default 16777216} maximum BSON document size in bytes
  * maxBytes {Number, default infinite} maximum number of bytes to receive
  * debug {Boolean, default false} whether to do extra console logging or not
  * hide {Boolean, default false} whether to suppress errors or not (used in tests)
  */
  constructor(opts) {
    if (typeof opts !== 'undefined' && typeof opts !== 'object') { throw new TypeError('opts must be an object'); }
    opts = opts || {};

    super(opts);

    if (typeof opts.raw !== 'undefined' && typeof opts.raw !== 'boolean') { throw new TypeError('opts.raw must be a boolean'); }
    if (typeof opts.maxDocLength !== 'undefined' && typeof opts.maxDocLength !== 'number') { throw new TypeError('opts.maxDocLength must be a number'); }
    if (typeof opts.maxBytes !== 'undefined' && typeof opts.maxBytes !== 'number') { throw new TypeError('opts.maxBytes must be a number'); }
    if (typeof opts.debug !== 'undefined' && typeof opts.debug !== 'boolean') { throw new TypeError('opts.debug must be a boolean'); }
    if (typeof opts.hide !== 'undefined' && typeof opts.hide !== 'boolean') { throw new TypeError('opts.hide must be a boolean'); }

    this._maxDocLength = opts.maxDocLength || 16777216;
    // bson spec: signed int32
    if (this._maxDocLength > 2147483647) { throw new Error('maxDocLength can not exceed 2147483647 bytes'); }

    this._maxBytes = opts.maxBytes;

    this._raw = opts.raw;
    this._debug = opts.debug || false;
    this._hide = !!opts.hide;

    this._writableState.objectMode = false;
    if (!this._raw) {
      this._readableState.objectMode = true;
    }

    // initialize internal buffer
    this._reset();
  }

  // reset internal buffer
  _reset() {
    if (this._debug) { console.log('_reset'); }
    this._buffersTotalLength = 0;
    this._buffers = [];
    this._buffer = Buffer.from([]);
    this._remainingDocLen = null;
    this._doclen = null;
  };

  // read up to doclen bytes
  _parseDocs(cb) {
    if (this._debug) { console.log('_parseDocs: start'); }


    // first make sure the expected document length is known
    if (this._remainingDocLen === null) {


      if (this._buffer.length < 4) {
        // wait for more chunks
        if (this._debug) { console.log('_parseDocs: wait for more chunks'); }
        cb();
        return;
      }

      // bson spec defines signed int32
      var doclen = this._buffer.readInt32LE(0);

      if (this._debug) { console.log('_parseDocs: doc length', doclen); }


      // should have at least have 5 bytes since the minimum document contains an int32 and a \x00 terminal
      if (doclen < 5) {
        // discard buffer
        this._reset();
        cb(new Error(`Invalid document length: ${doclen}, should be >=5.`));
        return;
      }

      if (doclen > this._maxDocLength) {
        // discard buffer
        this._reset();
        cb(new Error(`Document exceeds configured maximum length ${this._maxDocLength}`));
        return;
      }

      this._remainingDocLen = doclen;
      this._doclen = doclen;
    }

    // since the expected document length is known, make sure the complete length is in the internal buffer
    if (this._buffer.length < this._remainingDocLen) {
      // wait for more chunks
      cb();
      return;
    }

    // since the complete document is in the buffer, try to read and parse it as BSON

    // check if document ends with 0x00
    let docTerm = this._buffer[this._remainingDocLen - 1];
//    let docTerm = this._buffer.slice(this._remainingDocLen - 1,2).toString('hex');
    if ( docTerm!== 0x00) {
      // discard buffer
      this._reset();
      cb(new Error(`Invalid document termination, expected 0x00, found 0x${Number(docTerm).toString(16).padStart(2, '0')}`));
      return;
    }

    this._buffers.push(this._buffer.slice(0, this._remainingDocLen));
    this._buffersTotalLength += this._remainingDocLen;



    assert(this._buffersTotalLength == this._doclen);

    let rawdoc = Buffer.concat(this._buffers, this._doclen);
    let obj;

    try {
      obj = BSON.deserialize(rawdoc);
    } catch (err) {
      // discard buffer
      this._reset();
      cb(err);
      return;
    }

    // shift document from internal buffer and nullify expected document length
    this._buffer = this._buffer.slice(this._remainingDocLen);
    this._buffers = [];
    this._buffersTotalLength = 0;
    this._remainingDocLen = null;
    this._doclen = null;

    // push the raw or parsed doc out to the reader
    this.push(this._raw ? rawdoc : obj);

    // check if there might be any new document that can be parsed
    if (this._buffer.length > 4) {
      this._parseDocs(cb);
    } else {
      cb();
    }
  };

  _transform(chunk, encoding, cb) {
    if (this._debug) { console.log('_transform', chunk); }

    if (this._remainingDocLen !== null) {
      this._buffers.push(this._buffer);
      this._buffersTotalLength += this._buffer.length;
      this._remainingDocLen -= this._buffer.length;
    }
    this._buffer = chunk;

    if (this._maxBytes && this._buffersTotalLength + this._buffer.length > this._maxBytes) {
      cb(new Error('more than maxBytes received'));
      return;
    }

    this._parseDocs(cb);
  };

}

module.exports = BSONStream;
