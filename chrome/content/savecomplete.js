var savecompleteStrings = Components.classes["@mozilla.org/intl/stringbundle;1"].getService(Components.interfaces.nsIStringBundleService).createBundle("chrome://savecomplete/locale/save_complete.properties");
var savecomplete = {
    VERSION: '0.9b11',
    /* Translateable Strings */
    savePage: savecompleteStrings.GetStringFromName("savecompleteSavePage"),
    saveFilter: savecompleteStrings.GetStringFromName("savecompleteSaveFilter"),
    illegalProtocol: savecompleteStrings.GetStringFromName("savecompleteIllegalProtocol"),
    illegalContentType: savecompleteStrings.GetStringFromName("savecompleteIllegalContentType"),
    /* XPCOM Shortcuts */
    nsIIOService: Components.classes["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService),
    nsIRequest: Components.interfaces.nsIRequest,
    /* Constants */
    cssURIRegex: /url\(\s*(["']?)([^)"' \n\r\t]+)\1\s*\)/gm,
    STYLE_RULE: 1,
    IMPORT_RULE: 3,
    MEDIA_RULE: 4,
    defaultCharset: "ISO-8859-1",
    DEBUG_MODE: false,

    /* Main functions */
    onload: function() { // Called when Firefox runs
        // Make sure not called again and the listener is cleaned up
        window.removeEventListener('load',savecomplete.onload, true);

        // Show in context menu if the preference for it is set {
        var PrefBranch = Components.classes["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefBranch);
        var status = PrefBranch.getBoolPref("extensions.savecomplete@perlprogrammer.com.context");
        if(status == true) {
            var contextMenu = document.getElementById('contentAreaContextMenu');
            contextMenu.addEventListener('popupshowing',savecomplete.checkStatus,true);
        }
        //}
    },
    checkStatus: function() {
        gContextMenu.showItem("savecomplete_context", !( gContextMenu.inDirList || gContextMenu.isContentSelected || gContextMenu.onLink));
    },
    save: function() { // Called by selecting from either the context menu or the file menu
        // Get page that is supposed to be saved {
        var focusedWindow = document.commandDispatcher.focusedWindow;
        if (focusedWindow == window)
            focusedWindow = _content;
        //}

        // First check if it's html and if it's from an accepted protocol {
        if(focusedWindow.document.contentType != "text/html" && focusedWindow.document.contentType != "application/xhtml+xml") {
            alert(savecomplete.illegalContentType);
            return;
        } else if(focusedWindow.document.location.href.match(/^(ftp|file|chrome|view-source|about|javascript|news|snews|ldap|ldaps|mailto|finger|telnet|gopher|irc|mailbox)/)) {
            alert(savecomplete.illegalProtocol+" "+focusedWindow.document.location.href.split("://").shift()+"://");
            return;
        }
        //}

        // Create a save dialog and then display it {
        var nsIFilePicker = Components.interfaces.nsIFilePicker;
        var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(window, savecomplete.savePage, nsIFilePicker.modeSave);
        fp.appendFilter(savecomplete.saveFilter,"");

        // Get default save string {
        // The default save string is either the url after the '/' or it is the title of the document
        // I've tried to be as close to the default behavior in Firefox as possible
        var defaultSaveString = focusedWindow.document.location.href.split("?").shift();
        if(defaultSaveString.split("/").pop() == "") // Nothing after '/' so use the title
            defaultSaveString = focusedWindow.document.title+".html";
        else {
            defaultSaveString = defaultSaveString.split("/").pop();
            if(defaultSaveString.match(/\.x?html?$/) == null) defaultSaveString += ".html";
        }
        fp.defaultString = defaultSaveString.replace(/ *[:*?|<>\"/]+ */g," "); // Clean out illegal characters
        //}

        var res = fp.show();
        if (res == nsIFilePicker.returnCancel) return;
        //}

        // We have where they want it to be saved to so create the HTML file that needs to be saved {
        var htmlFile = fp.file;
        var exists = htmlFile.exists();
        if(exists == false)
            htmlFile.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0644);
        //}

        // Get the additional files folder name and create the directory {
        var folderName = htmlFile.leafName.replace(/\.\w*$/,"") /*.replace(/\s+/g,"_")*/ + "_files";
        var dir = htmlFile.parent;
        dir.append(folderName);
        if (dir.exists() == false) // Should wait until I know if this is necessary, but I don't - oh well :(
            dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0755);
        //}

        // Save important variables {
        savecomplete.file = htmlFile;
        savecomplete.folderName = folderName;
        savecomplete.dir = dir;
        savecomplete.doc = focusedWindow.document;
        savecomplete.baseURI = savecomplete.nsIIOService.newURI(focusedWindow.document.location.href,null,null);
        savecomplete.baseURL = focusedWindow.document.location.href;
        savecomplete.fixed = 0;
        //}

        // RUN!!!!!!!
        window.setTimeout(savecomplete.main,1);
    },
    main: function() {
        savecomplete.dump("Starting save...");
        try {
            // Get all the "base" URIs to save {
            var baseURIs = savecomplete.getBaseURIs(savecomplete.doc); // URIs found in the html document
            for (i in baseURIs) { if(baseURIs[i].where) { continue; } baseURIs[i].where = "base"; }
            //}

            // Get all the "other" URIs to save {
            var otherURIs = savecomplete.getOtherURIs(savecomplete.doc); // URIs found outside the html document
            for (i in otherURIs) { otherURIs[i].where = "extcss"; }
            //}

            // Start the save process for all of the found URIs
            savecomplete.asyncSave(baseURIs, otherURIs);
        } catch(e) {
            alert("Error caught in main() - version "+savecomplete.VERSION+":\n"+e);
        }
    },
    getBaseURIs: function(docNode) {
        var URIs = new Array();
        // Process elements which have a background attribute {
        var backIterator = docNode.evaluate("//*[@background]",docNode,null,0,null);
        var elem = true;
        while(elem = backIterator.iterateNext()) {
            URIs.push(savecomplete.createURI(elem.getAttribute("background"),savecomplete.baseURI,"attribute"));
        }
        //}

        // Process images {
        var images = docNode.getElementsByTagName("img");
        for(var i = 0; i < images.length; i++) {
            if(images[i].getAttribute && images[i].getAttribute("src")) {
                URIs.push(savecomplete.createURI(images[i].getAttribute("src"),savecomplete.baseURI,"attribute"));
            }
        }
        //}

        // Process input elements with an image type {
        var imageInputs = docNode.getElementsByTagName("input");
        for(var i = 0; i < imageInputs.length; i++) {
            if(imageInputs[i].getAttribute && imageInputs[i].getAttribute("type") == "image") {
                URIs.push(savecomplete.createURI(imageInputs[i].getAttribute("src"),savecomplete.baseURI,"attribute"));
            }
        }
        //}

        // Process script tags {
        var scripts = docNode.getElementsByTagName("script");
        for(var i = 0; i < scripts.length; i++) {
            if(scripts[i].getAttribute && scripts[i].getAttribute("src")) {
                URIs.push(savecomplete.createURI(scripts[i].getAttribute("src"),savecomplete.baseURI,"attribute"));
            }
        }
        //}

        // Process internal stylesheets {
        var styleSheets = docNode.styleSheets;
        for(var i = 0; i < styleSheets.length; i++) {
            if (styleSheets[i].ownerNode && styleSheets[i].ownerNode.getAttribute) {
                if(styleSheets[i].ownerNode.getAttribute("href")) {
                    URIs.push(savecomplete.createURI(styleSheets[i].ownerNode.getAttribute("href"),savecomplete.baseURI,"attribute"));
                } else {
                    //This stylesheet is inlined so it goes under the base URIs
                    var URITemp = savecomplete.getURIsFromStyleSheet(styleSheets[i],savecomplete.baseURI);
                    URIs = savecomplete.addToEnd(URIs, URITemp);
                }
            }
        }
        //}

        // Process elements with a style attribute {
        var styleIterator = docNode.evaluate("//*[@style]",docNode,null,0,null);
        var elem = true;
        while(elem = styleIterator.iterateNext()) {
            var cssText = elem.getAttribute("style");
            if(cssText) {
                var results = savecomplete.cssURIRegex.exec(cssText);
                if((cssText.match(savecomplete.cssURIRegex)) && (results)) {
                    for(var i = 2; i < results.length; i++) {
                        URIs.push(savecomplete.createURI(results[i],savecomplete.baseURI,"css"));
                    }
                }
            }
        }
        //}

        return URIs;
    },
    getOtherURIs: function(docNode) {
        var URIs = new Array(); //The list of additional URIs found
        var styleSheets = docNode.styleSheets;
        for(var i=0; i<styleSheets.length; i++) {
            if(styleSheets[i].ownerNode.getAttribute("href")) {
                URIs = savecomplete.addToEnd(URIs,savecomplete.getURIsFromStyleSheet(styleSheets[i],styleSheets[i].href));
            }
        }
        return URIs;
    },
    getURIsFromStyleSheet: function(styleSheet,importPath) {
        var URIs = new Array();
        var cssRules = styleSheet.cssRules;
        for(var r=0; r<cssRules.length; r++) {
            if(cssRules[r].type == savecomplete.IMPORT_RULE) { //For @import rules, need to go another level deep
                var importURI = savecomplete.createURI(cssRules[r].href,importPath,"import");
                if(cssRules[r].parentStyleSheet.ownerNode == null) {
                    importURI.where = "extcss";
                } else {
                    importURI.where = "base";
                }
                URIs.push(importURI);

                var importURIs = savecomplete.getURIsFromStyleSheet(cssRules[r].styleSheet,savecomplete.createURI(cssRules[r].href,importPath,"css"));
                for(i in importURIs) { importURIs[i].where = "extcss"; }
                URIs = savecomplete.addToEnd(URIs,importURIs);
            } else if(cssRules[r].type == savecomplete.STYLE_RULE) { //This works for simple CSS rules
                var cssText = cssRules[r].cssText;
                var results = savecomplete.cssURIRegex.exec(cssText);
                if((cssText.match(savecomplete.cssURIRegex)) && (results)) {
                    for(var i = 2; i < results.length; i++)
                        URIs.push(savecomplete.createURI(results[i],importPath,"css"));
                }
            } else if(cssRules[r].type == savecomplete.MEDIA_RULE) {
                var URITemp = savecomplete.getURIsFromStyleSheet(cssRules[r],importPath);
                URIs = savecomplete.addToEnd(URIs, URITemp);
            }
        }
        return URIs;
    },
    asyncSave: function(baseURIs,otherURIs) {
        // Create the URI queue of things that must be downloaded and (possibly) processed {
        var URIs = new Array();
        URIs = savecomplete.addToEnd(baseURIs,otherURIs);
        URIs = savecomplete.removeDupes(URIs);
        URIs.unshift(savecomplete.createURI(savecomplete.baseURL,"index")); // Add the index to the save list
        savecomplete.URIQueue = new Array();

        for(var i=0; i<URIs.length; i++) {
            if(!URIs[i].toString()) {
                // Doesn't seem to do anything but it was a bug fix for something, so I'm leaving it in
                continue;
            } else {
                savecomplete.URIQueue.push(URIs[i]);
            }
        }
        //}

        if(savecomplete.DEBUG_MODE) {
            savecomplete.dumpObj(URIs);
        }

        var junk = URIs.shift(); // Remove the index url from the list after it has been added to the download queue
        savecomplete.URIs = URIs;
        savecomplete.fixQueue = new Array();

        // Download the first item for processing (the base HTML doc)
        savecomplete.asyncGet(0);
    },
    asyncGet: function(queueNum) {
        // Don't get if called with a queueNum greater than the available URIs
        if(!savecomplete.URIQueue || queueNum >= savecomplete.URIQueue.length) return;

        // Skip if a dupe {
        if(savecomplete.URIQueue[queueNum].dupe) {
            savecomplete.fixed++;
            setTimeout("savecomplete.asyncGet("+(queueNum+1)+")",2);
            return;
        }
        //}

        // Create object for storing downloaded document {
        var docobj = new Object();
        docobj.contents = ""; docobj.contentType = ""; docobj.charset = "";
        // Set charset from document if base HTML, so that it is absolutely correct
        if(queueNum == 0) {
            docobj.charset = savecomplete.doc.characterSet;
        }
        //}

        // Create unichar stream loader and load channel (for getting from cache) {
        var fileURI = savecomplete.URIQueue[queueNum].toString().replace(/#.*$/, "");
        var loader = null; var channel = null;
        try {
            loader = Components.classes["@mozilla.org/network/unichar-stream-loader;1"].createInstance(Components.interfaces.nsIUnicharStreamLoader);
            channel = savecomplete.nsIIOService.newChannel(fileURI, "", null);
        } catch(e) {
            savecomplete.dump("Error with <" + fileURI + "> newURI/newChannel for queueNum " + queueNum + " of " + savecomplete.URIQueue.length + "\n" + e);
            savecomplete.dumpObj(savecomplete.URIQueue[queueNum]);
            setTimeout("savecomplete.asyncGet("+(queueNum+1)+")",2);
            return;
        }
        //}

        channel.loadFlags |= savecomplete.nsIRequest.LOAD_FROM_CACHE;

        // Set post data if it can be gotten {
        try {
            var sessionHistory = getWebNavigation().sessionHistory;
            var entry = sessionHistory.getEntryAtIndex(sessionHistory.index, false);
            entry = entry.QueryInterface(Components.interfaces.nsISHEntry);
            if(entry.postData) {
                var inputStream = Components.classes["@mozilla.org/io/string-input-stream;1"].createInstance(Components.interfaces.nsIStringInputStream);
                inputStream.setData(entry.postData, entry.postData.length);
                var uploadChannel = channel.QueryInterface(Components.interfaces.nsIUploadChannel);
                uploadChannel.setUploadStream(inputStream, "application/x-www-form-urlencoded", -1);
                channel.QueryInterface(Components.interfaces.nsIHttpChannel).requestMethod = "POST";
            }
        } catch (e) { savecomplete.dump("POST data error on url: " + fileURI + "\n" + e); }
        //}

        // Add docobj to the fix queue and start the unichar loader {
        savecomplete.fixQueue[queueNum] = docobj;
        try {
            var info = Components.classes["@mozilla.org/xre/app-info;1"].getService(Components.interfaces.nsIXULAppInfo);
            if(info.version.match(/3\./)) {
                // Firefox 3
                loader.init(new savecomplete.UnicharObserver(queueNum), null);
                channel.asyncOpen(loader, null);
            } else {
                // Pre-Firefox 3
                loader.init(channel, new savecomplete.UnicharObserver(queueNum), null, 0);
            }
        } catch(e) {
            savecomplete.dump("Error with loader: queueNum " + queueNum + "\n" + e);
        }
        //}

        // Get the next item in the queue
        setTimeout("savecomplete.asyncGet("+(queueNum+1)+")",100);
    },
    asyncFix: function(queueNum) {
        var docObject = savecomplete.fixQueue[queueNum];
        var contents = docObject.contents;
        if(contents == "") { savecomplete.fixed++; return; }
        var fixed = savecomplete.URIQueue[queueNum];
        if(queueNum == 0 || docObject.contentType == "text/html" || docObject.contentType == "application/xhtml+xml") {
            // Fix all URLs in this HTML document

            if (queueNum == 0) { // The root HTML document
                // Mark the document as coming from a certain URL (Like IE) {
                if(contents.match(/<html[^>]*>/i)) {
                    contents = contents.replace(/(<html[^>]*>)/i,"$1<!-- Source is "+fixed.toString()+" -->");
                } else {
                    contents = "<!-- Source is "+fixed.toString()+" -->\n" + contents;
                }
                //}

                // Comment out "base" element, which messes everything up
                contents = contents.replace(/(<base[^>]*>)/i,"<!--$1-->");

                // Fix all URLs so they point to the proper place {
                for(n in savecomplete.URIs) {
                    // Skip empty urls or ones that aren't for the base document {
                    if(!savecomplete.URIs[n].text || savecomplete.URIs[n].where != "base")
                        continue;
                    //}

                    var found = savecomplete.regexEscape(savecomplete.URIs[n].text);
                    var savePathURL = savecomplete.savePath(savecomplete.URIs[n],true).replace(' ', '%20', 'g');
                    if(savecomplete.URIs[n].type == "attribute") {
                        // Fix all instances where this url is found in an attribute
                        var re = new RegExp("(<[^>]+=(\"|')\\s*)"+found+"(\\s*\\2)","g");
                        contents = contents.replace(re,"$1"+savePathURL+"$3");
                    } else if(savecomplete.URIs[n].type == "css") {
                        // Fix all instances where this url is found in a URL command in css
                        // Fix in style attributes {
                        var re = new RegExp("(<[^>]+style=\"\\s*[^\"]+)url\\((\\s*([\"']?)\\s*)"+found+"(\\s*\\3\\s*)\\)([^\"]*\")","g");
                        contents = contents.replace(re,"$1url($3"+savePathURL+"$4)$5");
                        //}

                        // Fix in inlined style sheets {
                        var re = new RegExp("<style[^>]*>((?:.*?[\r\n\t ]*)*?)</style>","gmi");
                        var urlRe = new RegExp("url\\((\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                        var replaceFunc = function(all, match, offset) {
                            return all.replace(urlRe,"url($1"+savePathURL+"$3)");
                        };
                        contents = contents.replace(re, replaceFunc);
                        //}
                    } else if(savecomplete.URIs[n].type == "import") {
                        // Fix all instances where this url is found in an import rule
                        var re = new RegExp("<style[^>]*>((?:.*?[\r\n\t ]*)*?)</style>","gmi");
                        var noURLImportRe = new RegExp("(@import\\s*([\"'])\\s*)"+found+"(\\s*\\2)","g");
                        var urlImportRe   = new RegExp("(@import\\s+url\\(\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                        var replaceFunc = function(all, match, offset) {
                            all = all.replace(noURLImportRe, "$1"+savePathURL+"$3");
                            all = all.replace(urlImportRe ,  "$1"+savePathURL+"$3)");
                            return all;
                        };
                        contents = contents.replace(re, replaceFunc);
                    } else { continue; }
                }
                //}

                // TODO: Fix anchors to point to absolute location instead of relative

                // Save adjusted file {
                savecomplete.asyncWrite(savecomplete.file,contents,(docObject.charset) ? docObject.charset : savecomplete.defaultCharset);
                //}
            } else { // Other HTML files, if found
                // TODO: Fix anchors to point to absolute location instead of relative

                // Save adjusted file {
                var fileObj = savecomplete.getDir();
                fileObj.append(savecomplete.savePath(fixed,false));
                savecomplete.asyncWrite(fileObj,contents,(docObject.charset) ? docObject.charset : savecomplete.defaultCharset);
                //}
            }
        } else if(docObject.contentType == "text/css") {
            // Fix all URLs in this stylesheet {
            for(var n=0; n<savecomplete.URIs.length; n++) {
                // Skip empty urls or ones that aren't for external CSS files {
                if(!savecomplete.URIs[n].text || savecomplete.URIs[n].where != "extcss") {
                    continue;
                }
                //}

                var found = savecomplete.regexEscape(savecomplete.URIs[n].text);
                var savePathURL = savecomplete.savePath(savecomplete.URIs[n],false).replace(' ', '%20', 'g');
                if(savecomplete.URIs[n].type == "css") {
                    // Fix url functions in CSS
                    var re = new RegExp("url\\((\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                    contents = contents.replace(re,"url($1"+savePathURL+"$3)");
                } else if(savecomplete.URIs[n].type == "import") {
                    // Fix all instances where this url is found in an import rule
                    var noURLImportRe = new RegExp("(@import\\s*([\"'])\\s*)"+found+"(\\s*\\2)","g");
                    var urlImportRe   = new RegExp("(@import\\s+url\\(\\s*([\"']?)\\s*)"+found+"(\\s*\\2\\s*)\\)","g");
                    contents = contents.replace(noURLImportRe, "$1"+savePathURL+"$3");
                    contents = contents.replace(urlImportRe ,  "$1"+savePathURL+"$3)");
                } else {
                    savecomplete.dump("Skipping uri of type: '"+savecomplete.URIs[n].type+"'");
                    continue;
                }
            }
            //}

            // Save adjusted stylesheet {
            // Get the save path by appending the files directory to the file name and save it
            var fileObj = savecomplete.getDir();
            fileObj.append(savecomplete.savePath(fixed,false));
            savecomplete.asyncWrite(fileObj,contents,(docObject.charset) ? docObject.charset : savecomplete.defaultCharset);
            //}
        } else if(docObject.contentType != "") {
            // Something we aren't processing so use nsWebBrowserPersist, because it always works
            var persist = Components.classes["@mozilla.org/embedding/browser/nsWebBrowserPersist;1"].createInstance(Components.interfaces.nsIWebBrowserPersist);
            var fileObj = savecomplete.getDir();
            fileObj.append(savecomplete.savePath(fixed,false));
            persist.saveURI(fixed.URI, null , null , null , null , fileObj);
        } else {
            savecomplete.dump("Missing contentType");
            savecomplete.dumpObj(docObject);
        }

        savecomplete.fixQueue[queueNum].contents = ""; // For some small clean up

        savecomplete.fixed++;

        // Clean up if done {
        if(savecomplete.fixed == savecomplete.URIQueue.length) {
            savecomplete.cleanUp();
            savecomplete.dump("Complete save successful.");
            return;
        }
        //}
    },
    asyncWrite: function(file,contents,charset) {
        var foStream = Components.classes['@mozilla.org/network/file-output-stream;1'].createInstance(Components.interfaces.nsIFileOutputStream);
        var flags = 0x02 | 0x08 | 0x20;
        try {
            foStream.init(file, flags, 0644, 0);
            var os = Components.classes["@mozilla.org/intl/converter-output-stream;1"].createInstance(Components.interfaces.nsIConverterOutputStream);
            os.init(foStream, charset, 4096, "?".charCodeAt(0)); // Write to file converting all bad characters to "?"
            os.writeString(contents);
            os.close();
        } catch(e) {
            savecomplete.dump("Couldn't save "+file.leafName+"\n"+e);
        }
        foStream.close();
    },

    /* The following are helper functions */
    cleanUp: function() {
        // This may or may not be successful at COMPLETELY cleaning up, but it's close enough
        for(i in savecomplete.URIQueue) { savecomplete.URIQueue[i] = null; }
        savecomplete.URIQueue = null;

        for(i in savecomplete.URIs) { savecomplete.URIs[i] = null; }
        savecomplete.URIs = null;

        for(i in savecomplete.fixQueue) { savecomplete.fixQueue[i] = null; }
        savecomplete.fixQueue = null;

        savecomplete.file = null;
        savecomplete.folderName = null;
        savecomplete.dir = null;
        savecomplete.doc = null;
        savecomplete.baseURI = null;
        savecomplete.baseURL = null;
        savecomplete.dump("Clean up completed");
    },
    removeDupes: function(array) { // Sorts and splices out duplicates so that each thing is only downloaded once
        array.sort(savecomplete.URICompare);
        var previous = array[0];
        var spliceChanger = 0;
        for(var i=1; i<array.length; i++) {
            if(!previous.URI || !previous.toString()) {
                array.splice(--i,1);
                previous = array[i];
                continue;
            }
            if(previous.URI.equals(array[i-spliceChanger].URI)) {
                if(previous.where == array[i-spliceChanger].where && previous.type == array[i-spliceChanger] && previous.text == array[i-spliceChanger].text) {
                    array.splice(i,1);
                    i--;
                } else {
                    array[i].dupe = true;
                }
            } else {
                previous = array[i];
            }
        }
        return array;
    },
    regexEscape: function(string) { // Escapes a string for inserting into a regex
        var fixed = string.replace(/([?+$&|./()\[\]^*])/g,"\\$1");
        return fixed;
    },
    URICompare: function(a,b) { // Function passed to sort method for comparing special URI objects
        if (a.toString() < b.toString()) return -1;
        if (a.toString() > b.toString()) return 1;
        return 0;
    },
    getDir: function() { // Returns the nsFile object that corresponds to the directory where scripts, images, etc. are stored
        var dir = savecomplete.file.parent;
        dir.append(savecomplete.folderName);
        return dir;
    },
    savePath: function(URIObj, folder) { // Returns the path for the file to be saved to as a string
        var fileName = URIObj.URI.path.split('/').pop();
        if(fileName.replace(/\?.*$/,"") != "") { fileName = fileName.replace(/\?.*$/,""); }

        // TODO: Need to check if the file exists already so we can change the path (or replace)
        // because they might have two images with the same name and different paths which would be overwritten
        if(false) {
            for(var i = 2; i < 10; i++) {
                fileName.replace(/([^.]+)(.*)/, "$1-"+i+"$2");
                // Create nsIFile instance with the filename given and check if it exists and break if it does
                if(true) {
                    break;
                }
            }
        }

        if(folder) 
            return savecomplete.folderName+'/'+fileName;
        else
            return fileName;
    },
    createURI: function(relative, base, typeIn) {
        if(savecomplete.DEBUG_MODE) {
            savecomplete.dumpObj({relative: relative, base: base, typeIn: typeIn});
        }
        var uriString = "";
        if(relative.indexOf("http") == 0) {
            uriString = relative;
        } else if(base && !(base.resolve)) {
            uriString = savecomplete.nsIIOService.newURI(base,null,null).resolve(relative);
        } else if (base.resolve) {
            uriString = base.resolve(relative);
        }
        return {
                URI: savecomplete.nsIIOService.newURI(uriString,null,null),
                text: (relative) ? relative : "",
                type: typeIn?typeIn:"",
                dupe: false,
                where: "",
                toString: function() {
                    if(!this.URI) return false;
                    if(this.URI.path.indexOf("/") != 0) return this.URI.prePath+"/"+this.URI.path;
                    return this.URI.prePath+""+this.URI.path;
                }
               };
    },
    addToEnd: function(baseArray,newStuff) { // Simple concatenation function for arrays, since it doesn't appear that javascript supports array concatenation
        for(var i=0; i<newStuff.length; i++) {
            baseArray.push(newStuff[i]);
        }
        return baseArray;
    },
    UnicharObserver: function (aQueueNum) {
        /* onDetermineCharset() and onStreamComplete() borrowed from calWcapRequest.js, which is from the Mozilla
           source and written by Daniel Boelzle (daniel.boelzle@sun.com) */
        return ({
            mQueueNum: aQueueNum,
            mCharset: null,
            onDetermineCharset: function (loader, context, firstSegment, length) {
                if(savecomplete.fixQueue[this.mQueueNum].charset) {
                    this.mCharset = savecomplete.fixQueue[this.mQueueNum].charset;
                } else {
                    var channel = null;
                    if (loader) channel = loader.channel;
                    if (channel) this.mCharset = channel.contentCharset;
                    if (!this.mCharset || this.mCharset.length == 0) this.mCharset = savecomplete.defaultCharset;
                }
                return this.mCharset;
                // TODO: Kill the download here if it's not the right content type - it's a waste of CPU and slows stuff down
            },
            onStreamComplete: function (loader, context, status, unicharData) {
                switch (status) {
                    case Components.results.NS_OK: {
                        var str = "";
                        try {
                            if (unicharData) {
                                var str_ = {};
                                while (unicharData.readString(-1, str_)) str += str_.value;
                            }
                            savecomplete.fixQueue[this.mQueueNum].contents = str; str = null;
                            savecomplete.fixQueue[this.mQueueNum].charset = this.mCharset;
                            if(loader.channel)
                                savecomplete.fixQueue[this.mQueueNum].contentType = loader.channel.contentType;

                            setTimeout("savecomplete.asyncFix("+this.mQueueNum+")",1);
                        } catch (e) {
                            savecomplete.dump(e);
                        }
                        break;
                    }
                    default: {
                        savecomplete.dump(status);
                        break;
                    }
                }
            }
        });
    },

    /* Console logging functions */
    dump: function(message) { // Debuging function -- prints to javascript console
        var ConsoleService = Components.classes['@mozilla.org/consoleservice;1'].getService(Components.interfaces.nsIConsoleService);
        ConsoleService.logStringMessage(message);
    },
    dumpObj: function(obj) {
        var str = "";
        for(i in obj) {
            try {
                str += "obj["+i+"]: " + obj[i] + "\n";
            } catch(e) {
                str += "obj["+i+"]: Unavailable\n";
            }
        }
        savecomplete.dump(str);
    }
};
window.addEventListener('load',savecomplete.onload, true);
