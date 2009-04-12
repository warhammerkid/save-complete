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

var savecompleteStrings = Components.classes["@mozilla.org/intl/stringbundle;1"].getService(Components.interfaces.nsIStringBundleService).createBundle("chrome://savecomplete/locale/save_complete.properties");
var savecomplete = {
    DEBUG_MODE: false,
    savers: [],
    /* Translateable Strings */
    savePage: savecompleteStrings.GetStringFromName("savecompleteSavePage"),
    saveFilter: savecompleteStrings.GetStringFromName("savecompleteSaveFilter"),
    illegalProtocol: savecompleteStrings.GetStringFromName("savecompleteIllegalProtocol"),
    illegalContentType: savecompleteStrings.GetStringFromName("savecompleteIllegalContentType"),
    /* Main functions */
    onload: function() { // Called when Firefox runs
        // Make sure not called again and the listener is cleaned up
        window.removeEventListener('load',savecomplete.onload, true);

        // Set up preference change observer
        savecomplete.prefs = Components.classes["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefService).getBranch("extensions.savecomplete@perlprogrammer.com.");
        savecomplete.prefs.QueryInterface(Components.interfaces.nsIPrefBranch2);
        savecomplete.prefs.addObserver("", savecomplete, false);

        // Hook context menu to contextShow
        var contextMenu = document.getElementById('contentAreaContextMenu');
        contextMenu.addEventListener('popupshowing', savecomplete.contextShow, true);

        savecomplete.updateUIFromPrefs();
    },
    updateUIFromPrefs: function() {
        savecomplete.dump('Updating UI from preferences');
        var replaceBuiltin = savecomplete.prefs.getBoolPref('replace_builtin');

        // Show in context menu if the preference for it is set and replace builtin is not on
        savecomplete.showInContext = !replaceBuiltin && savecomplete.prefs.getBoolPref('context');

        // Replace built-in save if preference is set
        var builtinSaveCommand = document.getElementById('Browser:SavePage');
        var contextSave = document.getElementById('context-savepage');
        var saveCompleteMenuItem = document.getElementById('scNormalSaveFileMenuItem');
        if(replaceBuiltin) {
            builtinSaveCommand.setAttribute('oncommand', 'savecomplete.overrideSave()');
            contextSave.setAttribute('oncommand', 'savecomplete.overrideSave()');
            saveCompleteMenuItem.hidden = true;
        } else {
            builtinSaveCommand.setAttribute('oncommand', 'saveDocument(window.content.document)');
            contextSave.setAttribute('oncommand', 'gContextMenu.savePageAs();');
            saveCompleteMenuItem.hidden = false;
        }
    },
    contextShow: function() {
        if(!savecomplete.showInContext) return;
        gContextMenu.showItem("scNormalSaveContextMenuItem", !( gContextMenu.inDirList || gContextMenu.isContentSelected || gContextMenu.onLink));
    },
    save: function() { // Called by selecting from either the context menu or the file menu
        // Get page that is supposed to be saved
        var focusedWindow = document.commandDispatcher.focusedWindow;
        if (focusedWindow == window)
            focusedWindow = _content;

        // First check if it's html and if it's from an accepted protocol
        if(focusedWindow.document.contentType != "text/html" && focusedWindow.document.contentType != "application/xhtml+xml") {
            alert(savecomplete.illegalContentType);
            return;
        } else if(focusedWindow.document.location.href.match(/^(ftp|file|chrome|view-source|about|javascript|news|snews|ldap|ldaps|mailto|finger|telnet|gopher|irc|mailbox)/)) {
            alert(savecomplete.illegalProtocol+" "+focusedWindow.document.location.href.split("://").shift()+"://");
            return;
        }

        // Create a save dialog and then display it
        var nsIFilePicker = Components.interfaces.nsIFilePicker;
        var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(window, savecomplete.savePage, nsIFilePicker.modeSave);
        fp.appendFilter(savecomplete.saveFilter,"");

        // Get default save string=
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

        var res = fp.show();
        if (res == nsIFilePicker.returnCancel) return;

        var saver = savecomplete.getSaver(focusedWindow.document, fp.file);
        savecomplete.savers.push(saver);
        saver.run();
    },
    overrideSave: function() { // Called by overridden internal Firefox save
        /* overrideSave overrides functions defined in contentAreaUtils.js to
         * maintain support for the original save functionality, while at the same
         * time enhancing complete webpage saves.
         */
        // Check if can override successfully
        if(typeof window['getTargetFile'] == 'undefined' || typeof window['saveDocument'] == 'undefined') {
            savecomplete.save();
            return;
        }

        // Get document
        var focusedWindow = document.commandDispatcher.focusedWindow;
        if (focusedWindow == window) focusedWindow = _content;
        var doc = focusedWindow.document;

        // First, replace getTargetFile with one of our own making
        var originalGetTargetFile = window['getTargetFile'];
        window['getTargetFile'] = function(fpParams, aSkipPrompt) {
            // Run original
            var returnValue = originalGetTargetFile(fpParams, aSkipPrompt);
            if(!returnValue) return false;

            if(fpParams.saveMode != 0 && fpParams.saveAsType == 0) {
                // Save webpage complete selected so override and return false to stop internalSave
                savecomplete.dump('Using savecomplete save instead of firefox save');
                var saver = savecomplete.getSaver(doc, fpParams.file);
                savecomplete.savers.push(saver);
                saver.run();
                return false;
            }

            return returnValue;
        };

        // Call saveDocument
        saveDocument(doc, false);

        // Finally restore getTargetFile to what it was originally
        window['getTargetFile'] = originalGetTargetFile;
    },
    saverComplete: function(saver, result, messages) {
        for(var i = 0; i < savecomplete.savers.length; i++) {
            if(savecomplete.savers[i] === saver) {
                savecomplete.savers.splice(i, 1);
            }
        }

        savecomplete.dumpObj(messages);
    },
    getSaver: function(doc, file) {
        return new scPageSaver(
            doc,
            new scPageSaver.scDefaultFileSaver(file, savecomplete.getDirFromFile(file)),
            new scPageSaver.scDefaultFileProvider(),
            {
                saveIframes: savecomplete.prefs.getBoolPref('save_iframes'),
                saveObjects: savecomplete.prefs.getBoolPref('save_objects'),
                rewriteLinks: savecomplete.prefs.getBoolPref('rewrite_links'),
                callback: savecomplete.saverComplete
            }
        );
    },
    getDirFromFile: function(file) {
        // Returns a reference to the save directory through the given file
        var folderName = file.leafName.replace(/\.\w*$/,"") + "_files";
        var dir = file.clone();
        dir.leafName = folderName;
        return dir;
    },
    observe: function(subject, topic, data) {
        // Observer for pref changes
        if (topic != "nsPref:changed") return;

        savecomplete.dump('Pref changed: '+data);
        switch(data) {
            case 'context':
            case 'replace_builtin':
                savecomplete.updateUIFromPrefs();
                break;
        }
   },
    /* Console logging functions */
    dump: function(message) { // Debuging function -- prints to javascript console
        if(!savecomplete.DEBUG_MODE) return;
        var ConsoleService = Components.classes['@mozilla.org/consoleservice;1'].getService(Components.interfaces.nsIConsoleService);
        ConsoleService.logStringMessage(message);
    },
    dumpObj: function(obj) {
        if(!savecomplete.DEBUG_MODE) return;
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