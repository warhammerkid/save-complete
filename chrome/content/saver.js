/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Save Complete.
 *
 * The Initial Developer of the Original Code is
 * Stephen Augenstein <perl dot programmer at gmail dot com>.
 * Portions created by the Initial Developer are Copyright (C) 2006-2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Paolo Amadini <http://www.amadzone.org/>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * A page saver that saves the entire page after collecting all files it can from
 * the document and associated stylesheets.
 * @class scPageSaver
 */
/**
 * Creates a page saver object and initalizes. Call {@link run} to start the
 * saving process.
 * @constructor scPageSaver
 * @param {Document} doc - The document object for the page to be saved
 * @param {nsIFile} file - The ouput file for the HTML
 * @param {nsIFile} dataFolder - The output folder for all additional page data
 * @param {optional Object} options - Any optional data that affects the save, from settings to callbacks
 * @... {Boolean} saveIframes - Pass in as true to have iframes processed - defaults to false
 * @... {Boolean} saveObjects - Pass in to have object, embed, and applet tags processed - defaults to false
 * @... {Boolean} rewriteLinks - Pass in to have links rewritten to be absolute before saving
 * @... {Function} callback - The optional callback on save completion
 * @... {Object} progressListener - Progress listener that can QueryInterface to nsIWebProgressListener2.
 *                                  Pass false to prevent the progress from showing in the download manager.
 */
var scPageSaver = function(doc, file, dataFolder, options) {
    if(!options) options = {};

    this._ran = false;
    this._url = doc.location.href;
    this._uri = scPageSaver.nsIIOService.newURI(this._url, null, null);
    this._doc = doc;
    this._file = file;

    if(file.exists() == false) file.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0644);

    // Delete and re-create dataFolder so that it is clean
    var dataFolderBackup = dataFolder.parent;
    var folderName = dataFolder.leafName;
    if (dataFolder.exists()) dataFolder.remove(true);
    dataFolderBackup.append(folderName);
    this._dataFolder = dataFolderBackup;

    // Extract data from options
    this._callback = options['callback'];
    delete options['callback'];

    if(options.hasOwnProperty('progressListener')) {
        if(options['progressListener'] !== false) {
            this._listener = options['progressListener'].QueryInterface(Components.interfaces.nsIWebProgressListener2);
        }
        delete options['progressListener'];
    } else {
        this._listener = Components.classes["@mozilla.org/transfer;1"].createInstance(Components.interfaces.nsITransfer);
        this._listener.init(this._uri, scPageSaver.nsIIOService.newFileURI(this._file), "", null, null, null, this);
    }

    // Optional settings
    this._options = { // Defaults
        saveIframes: false,
        saveObjects: false,
        rewriteLinks: false
    };
    for(var prop in options) this._options[prop] = options[prop];
}

scPageSaver.SUCCESS = 'success';
scPageSaver.FAILURE = 'failure';
/* XPCOM Shortcuts */
scPageSaver.nsIIOService = Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService);
scPageSaver.nsIRequest = Components.interfaces.nsIRequest;
scPageSaver.webProgress = Components.interfaces.nsIWebProgressListener;
/* Constants */
scPageSaver.cssURIRegex = /url\(\s*(["']?)([^)"' \n\r\t]+)\1\s*\)/gm;
scPageSaver.STYLE_RULE = 1;
scPageSaver.IMPORT_RULE = 3;
scPageSaver.MEDIA_RULE = 4;
scPageSaver.DEFAULT_CHARSET = "ISO-8859-1";
scPageSaver.DEFAULT_WRITE_CHARSET = "UTF-8";

/**
 * Starts the saving process. Calls the callback when done saving or if it failed
 * with a status code as the first parameter.
 * @function run
 */
scPageSaver.prototype.run = function() {
    // Force run to only be called once
    if(this._ran) throw new Error('Cannot run more than once');
    this._ran = true;

    // Initialize data
    this._errors = [];
    this._simultaneousDownloads = 0;
    this._currentURIIndex = 0;
    this._uris = [];
    this._currentDownloadIndex = 0;
    this._downloads = [];
    this._persists = [];
    this._saveMap = {};
    this._timers = {};

    // Notify listener that we are starting and bump the progress change so if it's a transfer it shows up
    if(this._listener) {
        this._listener.onStateChange(null, null, scPageSaver.webProgress.STATE_START | scPageSaver.webProgress.STATE_IS_NETWORK, 1);
        this._listener.onProgressChange64(null, null, 0, 1, 0, 1);
    }

    // Start the process, running the extract, and then starting the downloader
    try {
        this._timers.extract = {start: new Date(), finish: null};
        this._extractURIs();
        this._timers.extract.finish = new Date();

        this._timers.download = {start: new Date(), finish: null};
        this._downloadNextURI();
    } catch(e) {
        this._errors.push(e.toString());
        this._finished();
    }
};

/**
 * Cancels the currently in progress saver
 * @function cancel
 * @param {optional nsresult} reason - The reason why the operation was canceled
 */
scPageSaver.prototype.cancel = function(reason) {
    clearTimeout(this._processorTimeout);
    for(var i = 0; i < this._downloads.length; i++) {
        this._downloads[i].cancel();
    }
    this._errors.push('Download canceled by user');
    this._finished();
}

/**
 * QueryInterface function to allow passing as cancelable to transfer
 * @function QueryInterface
 * @param {Object} iid - The interface to convert to
 */
scPageSaver.prototype.QueryInterface = function(iid) {
    if(iid.equals(Components.interfaces.nsICancelable)) {
        return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
},

/**
 * Extracts all URIs from the document, tagging them and storing them for processing.
 * @function _extractURIs
 */
scPageSaver.prototype._extractURIs = function() {
    var e = null, iter = null;

    // Process images
    iter = this._doc.evaluate("//img[@src]", this._doc, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    while(e = iter.iterateNext()) {
        this._uris.push(new scPageSaver.scURI(e.getAttribute('src'), this._uri, 'attribute', 'base'));
    }

    // Process script tags
    iter = this._doc.evaluate("//script[@src]", this._doc, null, 0, null);
    while(e = iter.iterateNext()) {
        this._uris.push(new scPageSaver.scURI(e.getAttribute('src'), this._uri, 'attribute', 'base'));
    }

    if(this._options['saveIframes']) {
        // Only save the html in the iframe - don't process the iframe document
        iter = this._doc.evaluate("//iframe[@src]", this._doc, null, 0, null);
        while(e = iter.iterateNext()) {
            this._uris.push(new scPageSaver.scURI(e.getAttribute('src'), this._uri, 'attribute', 'base'));
        }
    }

    if(this._options['saveObjects']) {
        // Process embed tags
        iter = this._doc.evaluate("//embed[@src]", this._doc, null, 0, null);
        while(e = iter.iterateNext()) {
            this._uris.push(new scPageSaver.scURI(e.getAttribute('src'), this._uri, 'attribute', 'base'));
        }

        // Process object tags (or at least try to)
        iter = this._doc.evaluate("//object", this._doc, null, 0, null);
        while(e = iter.iterateNext()) {
            if(e.getAttribute('data')) {
                this._uris.push(new scPageSaver.scURI(e.getAttribute('data'), this._uri, 'attribute', 'base'));
            }

            // Find param that references the object's data
            var p = null;
            var pIter = this._doc.evaluate('param', e, null, 0, null);
            while(p = pIter.iterateNext()) {
                var param = p.getAttribute('name');
                if(param == 'movie' || param == 'src') {
                    this._uris.push(new scPageSaver.scURI(p.getAttribute('value'), this._uri, 'attribute', 'base'));
                    break;
                }
            }
        }
    }

    // Process input elements with an image type
    iter = this._doc.evaluate("//input[@type='image']", this._doc, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    while(e = iter.iterateNext()) {
        this._uris.push(new scPageSaver.scURI(e.getAttribute('src'), this._uri, 'attribute', 'base'));
    }

    // Process elements which have a background attribute
    iter = this._doc.evaluate("//*[@background]", this._doc, null, 0, null);
    while(e = iter.iterateNext()) {
        this._uris.push(new scPageSaver.scURI(e.getAttribute('background'), this._uri, 'attribute', 'base'));
    }

    // Process IE conditional comments
    iter = this._doc.evaluate("//comment()", this._doc, null, 0, null);
    while(e = iter.iterateNext()) {
        if(typeof e.data != 'string') continue;
        if(!/^\[if[^\]]+\]>/.test(e.data)) continue; // Check if it starts with [if...]>

        var results = null;

        // Extract link element refs (stylesheets)
        var linkRe = /<link[^>]+href=(["'])([^"']*)\1/igm;
        while((results = linkRe.exec(e.data)) != null) {
            this._uris.push(new scPageSaver.scURI(results[2], this._uri, 'attribute', 'base'));
        }

        // Extract script elements refs
        var scriptRe = /<script[^>]+src=(["'])([^"']*)\1/igm;
        while((results = scriptRe.exec(e.data)) != null) {
            this._uris.push(new scPageSaver.scURI(results[2], this._uri, 'attribute', 'base'));
        }
    }

    // Process elements with a style attribute
    iter = this._doc.evaluate("//*[@style]", this._doc, null, 0, null);
    while(e = iter.iterateNext()) {
        var cssText = e.getAttribute("style");
        if(!cssText) continue;

        var results = null;
        while((results = scPageSaver.cssURIRegex.exec(cssText)) != null) {
            this._uris.push(new scPageSaver.scURI(results[2], this._uri, 'css', 'base'));
        }
    }

    // Process internal stylesheets
    var styleSheets = this._doc.styleSheets;
    for(var i = 0; i < styleSheets.length; i++) {
        if (styleSheets[i].ownerNode && styleSheets[i].ownerNode.getAttribute) {
            if(styleSheets[i].ownerNode.getAttribute("href")) {
                this._uris.push(new scPageSaver.scURI(styleSheets[i].ownerNode.getAttribute("href"), this._uri, 'attribute', 'base'));
                this._extractURIsFromStyleSheet(styleSheets[i], styleSheets[i].href)
            } else {
                this._extractURIsFromStyleSheet(styleSheets[i], this._uri, true);
            }
        }
    }

    // Process all dupes
    this._processDupes();

    // Add base document path to the beginning (now because dupe processing messes with _uris array)
    this._uris.unshift(new scPageSaver.scURI(this._url, this._uri, 'index', 'base'));
};

/**
 * Extracts all URIs from the given stylesheet, tagging them and storing them for processing.
 * @function _extractURIsFromStyleSheet
 * @param {CSSStyleSheet} styleSheet - The stylesheet to extract from
 * @param {String or nsIURI} importPath - The path for the stylesheet that it was imported from
 * @param {optional Boolean} inline - Whether or not the spreadsheet is inlined into the document body. Defaults to false.
 */
scPageSaver.prototype._extractURIsFromStyleSheet = function(styleSheet, importPath, inline) {
    if(typeof inline == 'undefined') inline = false;

    var cssRules = styleSheet.cssRules;
    for(var r = 0; r < cssRules.length; r++) {
        var rule = cssRules[r];

        if(rule.type == scPageSaver.IMPORT_RULE) {
            // Add import url and process imported stylesheet
            var importRuleURI = new scPageSaver.scURI(rule.href, importPath, 'import', inline?'base':'extcss');
            this._uris.push(importRuleURI);

            this._extractURIsFromStyleSheet(rule.styleSheet, importRuleURI.uri);
        } else if(rule.type == scPageSaver.STYLE_RULE) {
            var results = null;
            while((results = scPageSaver.cssURIRegex.exec(rule.cssText)) != null) {
                this._uris.push(new scPageSaver.scURI(results[2], importPath, 'css', inline?'base':'extcss'));
            }
        } else if(rule.type == scPageSaver.MEDIA_RULE) {
            this._extractURIsFromStyleSheet(rule, importPath, inline);
        }
    }
};

/**
 * Downloads the next URI in the stack. Once it's done, starts the processor.
 * @function _downloadNextURI
 */
scPageSaver.prototype._downloadNextURI = function() {
    // 4 simultaneous "downloads" max
    while(this._simultaneousDownloads < 4 && this._currentURIIndex < this._uris.length) {
        var currentURI = this._uris[this._currentURIIndex];
        this._currentURIIndex++;

        // Skip dupes
        if(currentURI.dupe) {
            continue;
        }

        var download = new scPageSaver.scDownload(currentURI);
        if(currentURI.type == 'index') download.charset = this._doc.characterSet; // Set character set from document
        this._downloads.push(download);
        this._simultaneousDownloads++;

        download.download(this._downloadFinished, this);
    }
};

/**
 * Download completion callback
 * @function _downloadFinished
 */
scPageSaver.prototype._downloadFinished = function() {
    this._simultaneousDownloads--;
    if(this._listener) {
        var progress = this._downloads.length - this._simultaneousDownloads;
        var maxProgress = this._uris.length;
        this._listener.onProgressChange64(null, null, progress, maxProgress, progress, maxProgress);
    }

    // Stop downloading if beyond end of uri list
    if(this._currentURIIndex >= this._uris.length) {
        if(this._simultaneousDownloads == 0) {
            // Downloading finished so start the processor
            this._timers.download.finish = new Date();

            this._timers.process = {start: new Date(), finish: null};
            this._processNextURI();
        }
    } else {
        this._downloadNextURI();
    }
}

/**
 * Fixes the next URI in the stack and saves it to disk.
 * @function _processNextURI
 */
scPageSaver.prototype._processNextURI = function() {
    // Stop processing if beyond end of download list
    if(this._currentDownloadIndex >= this._downloads.length) {
        this._finished();
        return;
    }

    var me = this, doContinue = true;
    var download = this._downloads[this._currentDownloadIndex];
    var data = download.contents;
    if(download.failed) {
        this._errors.push("Download failed for uri: "+download.uri);
        this._currentDownloadIndex++;
        this._processorTimeout = setTimeout(function() { me._processNextURI();}, 2);
        return;
    }

    if(download.uri.type == 'index' || download.contentType == "text/html" || download.contentType == "application/xhtml+xml") {
        // Fix all URLs in this HTML document
        if (download.uri.type == 'index') {
            // The root HTML document

            // Mark the document as coming from a certain URL (Like IE)
            if(data.match(/<html[^>]*>/i)) {
                data = data.replace(/(<html[^>]*>)/i,"$1<!-- Source is "+download.uri.toString()+" -->");
            } else {
                data = "<!-- Source is "+download.uri.toString()+" -->\n" + data;
            }

            // Comment out "base" element, which messes everything up
            data = data.replace(/(<base[^>]*>)/i,"<!--$1-->");

            // Fix all URLs so they point to the proper place
            for(var n = 0; n < this._uris.length; n++) {
                var uri = this._uris[n];

                // Skip empty urls or ones that aren't for the base document
                if(!uri.extractedURI || uri.type == 'index' || uri.where != "base") continue;

                var found = this._regexEscape(uri.extractedURI);
                var savePathURL = this._savePath(uri, true).replace(' ', '%20', 'g');
                if(uri.type == "attribute") {
                    // Fix all instances where this url is found in an attribute
                    var re = new RegExp("(<[^>]+=([\"'])\\s*)"+found+"(\\s*\\2)","g");
                    data = data.replace(re, "$1"+savePathURL+"$3");
                } else if(uri.type == "css") {
                    // Fix all instances where this url is found in a URL command in css
                    // Fix in style attributes
                    var re = new RegExp("(<[^>]+style=\"\\s*[^\"]+)url\\((\\s*([\"']?)\\s*)"+found+"(\\s*\\3\\s*)\\)([^\"]*\")","g");
                    data = data.replace(re, "$1url($3"+savePathURL+"$4)$5");

                    // Fix in inlined style sheets
                    var re = new RegExp("<style[^>]*>((?:.*?[\r\n\t ]*)*?)</style>","gmi");
                    var urlRe = new RegExp("url\\((\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                    var replaceFunc = function(all, match, offset) {
                        return all.replace(urlRe, "url($1"+savePathURL+"$3)");
                    };
                    data = data.replace(re, replaceFunc);
                } else if(uri.type == "import") {
                    // Fix all instances where this url is found in an import rule
                    var re = new RegExp("<style[^>]*>((?:.*?[\r\n\t ]*)*?)</style>","gmi");
                    var noURLImportRe = new RegExp("(@import\\s*([\"'])\\s*)"+found+"(\\s*\\2)","g");
                    var urlImportRe   = new RegExp("(@import\\s+url\\(\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                    var replaceFunc = function(all, match, offset) {
                        all = all.replace(noURLImportRe, "$1"+savePathURL+"$3");
                        all = all.replace(urlImportRe ,  "$1"+savePathURL+"$3)");
                        return all;
                    };
                    data = data.replace(re, replaceFunc);
                }
            }

            // Fix anchors to point to absolute location instead of relative
            if(this._options['rewriteLinks']) {
                var me = this;
                var replaceFunc = function() {
                    var match = /^([^:]+):/.exec(arguments[0]);
                    if(match && match[1] != 'http' && match[1] != 'https')
                        return arguments[0];
                    else
                        return arguments[1]+arguments[2]+me._uri.resolve(arguments[3])+arguments[2];
                }
                data = data.replace(/(<a[^>]+href=)(["'])([^"']+)\2/igm, replaceFunc);
            }

            // Save adjusted file
            this._writeFile(this._file, data, download.charset);
        } else {
            // Other HTML files, if found
            // Save adjusted file
            var fileObj = this._dataFolder.clone();
            fileObj.append(this._savePath(download.uri,false));
            this._writeFile(fileObj, data, download.charset);
        }
    } else if(download.contentType == "text/css") {
        // Fix all URLs in this stylesheet

        for(var n = 0; n < this._uris.length; n++) {
            var uri = this._uris[n];

            // Skip empty urls or ones that aren't for external CSS files
            if(!uri.extractedURI || uri.type == 'index' || uri.where != "extcss") continue;

            var found = this._regexEscape(uri.extractedURI);
            var savePathURL = this._savePath(uri, false).replace(' ', '%20', 'g');
            if(uri.type == "css") {
                // Fix url functions in CSS
                var re = new RegExp("url\\((\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                data = data.replace(re,"url($1"+savePathURL+"$3)");
            } else if(uri.type == "import") {
                // Fix all instances where this url is found in an import rule
                var noURLImportRe = new RegExp("(@import\\s*([\"'])\\s*)"+found+"(\\s*\\2)","g");
                var urlImportRe   = new RegExp("(@import\\s+url\\(\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                data = data.replace(noURLImportRe, "$1"+savePathURL+"$3");
                data = data.replace(urlImportRe ,  "$1"+savePathURL+"$3)");
            }
        }

        // Save adjusted stylesheet
        var fileObj = this._dataFolder.clone();
        fileObj.append(this._savePath(download.uri,false));
        this._writeFile(fileObj, data, download.charset);
    } else if(/^text\//.test(download.contentType) || download.contentType == 'application/x-javascript') {
        // Had problems with nsWebBrowserPersist and text files, so for now I'll do the saving
        var fileObj = this._dataFolder.clone();
        fileObj.append(this._savePath(download.uri,false));
        this._writeFile(fileObj, data, download.charset);
    } else if(download.contentType != "") {
        // Something we aren't processing so use nsWebBrowserPersist, because it always works
        var persist = Components.classes["@mozilla.org/embedding/browser/nsWebBrowserPersist;1"].createInstance(Components.interfaces.nsIWebBrowserPersist);
        var fileObj = this._dataFolder.clone();
        fileObj.append(this._savePath(download.uri,false));
        persist.progressListener = new scPageSaver.scPersistListener(this);
        try {
            persist.saveURI(download.uri.uri, null , null , null , null , fileObj);
            this._persists.push(persist); // Just so we retain a reference to it
            doContinue = false; // Calling _processNextURI handled by persist listener
        } catch(e) {
            this._errors.push('Error persisting URI: '+download.uri+"\n"+e);
        }
    } else {
        this._errors.push('Missing contentType: '+download.uri);
    }

    download.contents = ""; // For some small clean up

    this._currentDownloadIndex++;
    if(doContinue) this._processorTimeout = setTimeout(function() { me._processNextURI();}, 2);
};

/**
 * Cleans up and calls callback. Called when finished downloading and processing.
 * @function _finished
 */
scPageSaver.prototype._finished = function() {
    if(this._timers.process) this._timers.process.finish = new Date();

    if(this._callback) {
        var status = this._errors.length == 0 ? scPageSaver.SUCCESS : scPageSaver.FAILURE;
        this._callback(this, status, {errors: this._errors, timers: this._timers});
    }

    if(this._listener) this._listener.onStateChange(null, null, scPageSaver.webProgress.STATE_STOP | scPageSaver.webProgress.STATE_IS_NETWORK, 1);

    this._listener = null;
    this._uris = null;
    this._downloads = null;
    this._persists = null;
    this._callback = null;
    this._saveMap = null;
    this._errors = null;
    this._timers = null;
}

/**
 * Writes the file data to disk
 * @function _writeFile
 * @param {nsIFile} file - The file to write to
 * @param {String} contents - The file contents
 * @param {String} charset - The file character set
 */
scPageSaver.prototype._writeFile = function(file, contents, charset) {
    var foStream = Components.classes['@mozilla.org/network/file-output-stream;1'].createInstance(Components.interfaces.nsIFileOutputStream);
    var flags = 0x02 | 0x08 | 0x20;
    if(!charset) charset = scPageSaver.DEFAULT_WRITE_CHARSET;
    try {
        foStream.init(file, flags, 0644, 0);
        var os = Components.classes["@mozilla.org/intl/converter-output-stream;1"].createInstance(Components.interfaces.nsIConverterOutputStream);
        os.init(foStream, charset, 4096, "?".charCodeAt(0)); // Write to file converting all bad characters to "?"
        os.writeString(contents);
        os.close();
    } catch(e) {
        this._errors.push("Couldn't save "+file.leafName+"\n"+e);
    }
    foStream.close();
};

/**
 * Removes complete dupes and marks url dupes.
 * @function _processDupes
 */
scPageSaver.prototype._processDupes = function() {
    this._uris.sort(scPageSaver.scURI.compare);
    var previous = this._uris[0];
    for(var i = 1; i < this._uris.length; i++) {
        if(!previous.uri || !previous.toString()) {
            this._uris.splice(--i, 1);
            previous = this._uris[i];
            continue;
        }

        if(previous.isExactDupe(this._uris[i])) {
            this._uris.splice(i--, 1);
        } else if(previous.isDupe(this._uris[i])) {
            this._uris[i].dupe = true;
        } else {
            previous = this._uris[i];
        }
    }
};

/**
 * Calculates the save path for the given scURI object. Is only used for files
 * in the extras folder.
 * @function {String} _savePath
 * @param {scPageSaver.scURI} uri - The uri object to generate the path for
 * @param {optional Boolean} includeFolder - Whether or not to include the data folder in the path
 * @return The calculated save path
 */
scPageSaver.prototype._savePath = function(uri, includeFolder) {
    var saveKey = uri.toString();

    if(typeof this._saveMap[saveKey] == 'undefined') {
        // Determine the base file name to use
        var fileName = uri.uri.path.split('/').pop();
        fileName = fileName.replace(/\?.*$/,"");
        if(fileName == "") fileName = "unnamed";

        /* Here we must check if the file can be saved to disk with the chosen
         * name. One case where the file cannot be saved is when the name
         * conflicts with one of another file that must be saved. Note that
         * whether two names collide is dependent on the underlying filesystem:
         * for example, on FAT on Windows two file names that differ only in
         * case conflict with each other, while on ext2 on Linux this conflict
         * does not occur.
         */
        // Build a new nsIFile corresponding to the file name to be saved
        var actualFileOnDisk = this._dataFolder.clone();
        if(!this._dataFolder.exists()) this._dataFolder.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0755);
        actualFileOnDisk.append(fileName);

        // Since the file is not actually saved until later, we must create a placeholder
        actualFileOnDisk.createUnique(Components.interfaces.nsIFile.FILE_TYPE, 0644);

        // Find out which unique name has been used
        fileName = actualFileOnDisk.leafName;

        // Save to save map
        this._saveMap[saveKey] = fileName;
    }

    return (includeFolder ? this._dataFolder.leafName+'/' : '') + this._saveMap[saveKey];
};

/**
 * Escapes a string for insertion into a regex.
 * @funcation {String} _regexEscape
 * @param {String} str - The string to escape
 * @return The escaped string
 */
scPageSaver.prototype._regexEscape = function(str) {
    return str.replace(/([?+$&|./()\[\]^*])/g,"\\$1");
};

/**
 * Simple URI data storage class
 * @class scPageSaver.scURI
 */
/**
 * Creates a URI object.
 * @constructor scPageSaver.scURI
 * @param {String} extractedURI - The URI extracted from the document
 * @param {String or nsIURI} base - The base URI - used to resolve extracted URI against
 * @param {String} type - The type of place where the URL was extracted from, like an attribute, import rule, style rule, etc.
 * @param {String} where - The type of file it came from - "base" or "extcss"
 */
scPageSaver.scURI = function(extractedURI, base, type, where) {
    var uriString = "";
    if(extractedURI.indexOf("http") == 0) {
        uriString = extractedURI;
    } else if(base && !(base.resolve)) {
        uriString = scPageSaver.nsIIOService.newURI(base, null, null).resolve(extractedURI);
    } else if (base.resolve) {
        uriString = base.resolve(extractedURI);
    }

    this.uri = scPageSaver.nsIIOService.newURI(uriString, null, null);
    this.extractedURI = extractedURI || "";
    this.type = type;
    this.where = where;
    this.dupe = false;
};

/**
 * Tests of the path is the URI object is the same as the given one.
 * @function {Boolean} isDupe
 * @param {scPageSaver.scURI} compare - The object to compare against
 * @return Whether they have the same path
 */
scPageSaver.scURI.prototype.isDupe = function(compare) {
    return this.uri.equals(compare.uri);
}

/**
 * Tests if both URI objects are exact dupes, coming from the same location, with
 * the same type, and with the same path.
 * @function {Boolean} isExactDupe
 * @param {scPageSaver.scURI} compare - The object to compare against
 * @return Whether they are exactly the same
 */
scPageSaver.scURI.prototype.isExactDupe = function(compare) {
    return (this.isDupe(compare) && this.where == compare.where && this.type == compare.type && this.extractedURI == compare.extractedURI);
}

/**
 * Returns a string representation of the object
 * @function {String} toString
 * @return The string representation of the URI
 */
scPageSaver.scURI.prototype.toString = function() {
    if(typeof this._string == 'undefined') {
        if(!this.uri) {
            this._string = false;
        } else if(this.uri.path.indexOf("/") != 0) {
            this._string = this.uri.prePath+"/"+this.uri.path;
        } else {
            this._string = this.uri.prePath+""+this.uri.path;
        }
    }
    return this._string;
};

/**
 * Comparison function passed to the sort method for scURI objects
 * @function {static int} compare
 * @param {scPageSaver.scURI} a - The first object
 * @param {scPageSaver.scURI} b - The second object
 * @return Ordering int for sort
 */
scPageSaver.scURI.compare = function(a,b) {
    if (a.toString() < b.toString()) return -1;
    if (a.toString() > b.toString()) return 1;
    return 0;
};

/**
 * Download data storage class
 * @class scPageSaver.scDownload
 */
/**
 * Creates a download object.
 * @constructor scPageSaver.scDownload
 * @param {scPageSaver.scURI} uri - The URI for the download
 */
scPageSaver.scDownload = function(uri) {
    this.contents = "";
    this.contentType = "";
    this.charset = "";
    this.uri = uri;
}

/**
 * Starts the download. Calls the callback when the file is finished loading.
 * @function download
 * @param {Function} callback - The callback function
 * @param {optional Object} thisObj - The object to use as this when calling the callback
 */
scPageSaver.scDownload.prototype.download = function(callback, thisObj) {
    if(typeof thisObj == 'undefined') thisObj = null;
    this._callback = { func: callback, thisObj: thisObj };

    // Create unichar stream loader and load channel (for getting from cache)
    var fileURI = this.uri.toString().replace(/#.*$/, "");
    try {
        this._loader = Components.classes["@mozilla.org/network/unichar-stream-loader;1"].createInstance(Components.interfaces.nsIUnicharStreamLoader);
        this._channel = scPageSaver.nsIIOService.newChannel(fileURI, "", null);
    } catch(e) {
        this._done(true);
        return;
    }

    this._channel.loadFlags |= scPageSaver.nsIRequest.LOAD_FROM_CACHE;

    // Set post data if it can be gotten
    try {
        var sessionHistory = getWebNavigation().sessionHistory;
        var entry = sessionHistory.getEntryAtIndex(sessionHistory.index, false);
        entry = entry.QueryInterface(Components.interfaces.nsISHEntry);
        if(entry.postData) {
            var inputStream = Components.classes["@mozilla.org/io/string-input-stream;1"].createInstance(Components.interfaces.nsIStringInputStream);
            inputStream.setData(entry.postData, entry.postData.length);
            var uploadChannel = this._channel.QueryInterface(Components.interfaces.nsIUploadChannel);
            uploadChannel.setUploadStream(inputStream, "application/x-www-form-urlencoded", -1);
            this._channel.QueryInterface(Components.interfaces.nsIHttpChannel).requestMethod = "POST";
        }
    } catch (e) {}

    try {
        this._loader.init(new scPageSaver.scDownload.UnicharObserver(this), null);
        this._channel.asyncOpen(this._loader, null);
    } catch(e) {
        this._done(true);
    }
};

/**
 * Cancels the download if it's active.
 * @function cancel
 */
scPageSaver.scDownload.prototype.cancel = function() {
    if(this._channel) {
        this._channel.cancel(Components.results.NS_BINDING_ABORTED);
    }
    this._channel = null;
    this._loader = null;
    this._callback = null;
    this.failed = true;
    this.contents = null;
    this.contentType = null;
    this.charset = null;
}

/**
 * Called when the downloading is done. Cleans up, and calls callback.
 * @function _done
 * @param {optional Boolean} failed - Whether done is being called after a failure or not. Defaults to false.
 */
scPageSaver.scDownload.prototype._done = function(failed) {
    if(typeof failed == 'undefined') failed = false;
    this._loader = null;
    this._channel = null;
    this.failed = failed;
    this._callback.func.call(this._callback.thisObj);
    this._callback = null;
};

/**
 * Download Observer which converts contents to unicode.
 * @class scPageSaver.scDownload.UnicharObserver
 */
scPageSaver.scDownload.UnicharObserver = function (download) {
    this._download = download;
    this._charset = null;
}
scPageSaver.scDownload.UnicharObserver.prototype.onDetermineCharset = function (loader, context, firstSegment, length) {
    if(this._download.charset) {
        this._charset = this._download.charset;
    } else {
        var channel = null;
        if (loader) channel = loader.channel;
        if (channel) this._charset = channel.contentCharset;
        if (!this._charset || this._charset.length == 0) this._charset = scPageSaver.DEFAULT_CHARSET;
    }
    return this._charset;
}
scPageSaver.scDownload.UnicharObserver.prototype.onStreamComplete = function (loader, context, status, unicharData) {
    switch (status) {
        case Components.results.NS_OK:
            var str = "";
            try {
                if (unicharData) {
                    var str_ = {};
                    while (unicharData.readString(-1, str_)) str += str_.value;
                }
            } catch (e) {
                this._download._done(true);
                return;
            }

            this._download.contents = str;
            this._download.charset = this._charset;
            if(loader.channel)
                this._download.contentType = loader.channel.contentType;

            this._download._done();
            break;
        default:
            // Download failed
            this._download._done(true);
            break;
    }
};

/**
 * nsIWebBrowserPersist listener
 * @class scPageSaver.scPersistListener
 */
scPageSaver.scPersistListener = function(saver) {
    this._saver = saver;
}
scPageSaver.scPersistListener.prototype.QueryInterface = function(iid) {
    if (iid.equals(Components.interfaces.nsIWebProgressListener)) {
        return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
};
scPageSaver.scPersistListener.prototype.onStateChange = function(webProgress, request, stateFlags, status) {
    if(stateFlags & Components.interfaces.nsIWebProgressListener.STATE_STOP && stateFlags & Components.interfaces.nsIWebProgressListener.STATE_IS_NETWORK) {
        this._saver._processNextURI();
        this._saver = null;
    }
};
scPageSaver.scPersistListener.prototype.onProgressChange = function() {}
scPageSaver.scPersistListener.prototype.onLocationChange = function() {}
scPageSaver.scPersistListener.prototype.onStatusChange = function() {}
scPageSaver.scPersistListener.prototype.onSecurityChange = function() {}