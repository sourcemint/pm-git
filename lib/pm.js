
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const EXEC = require("child_process").exec;
const SPAWN = require("child_process").spawn;
const GIT = require("./git");
const TERM = require("sourcemint-util-js/lib/term");
const Q = require("sourcemint-util-js/lib/q");
const URI_PARSER = require("sourcemint-pm-sm/lib/uri-parser");
const URL_PROXY_CACHE = require("sourcemint-util-js/lib/url-proxy-cache");
const FS_RECURSIVE = require("sourcemint-util-js/lib/fs-recursive");


exports.install = function(pm, options) {

    return exports.clone(pm, options);
    
}

exports.status = function(pm, options) {
    return GIT.interfaceForPath(pm.context.package.path).status();
}

exports.clone = function(pm, options) {

    options = options || {};

    ASSERT(typeof options.locator !== "undefined", "'options.locator' required!");

    var packagePath = pm.context.package.path;

    var parsedUri = URI_PARSER.parse(options.locator);

    if (!parsedUri.vendor || parsedUri.vendor.id !== "github.com") {
        TERM.stdout.writenl("\0red(" + "ERROR: " + "Only github.com URIs are supported at this time!" + "\0)");
        return;
    }

    var uri = parsedUri.locators["git-" + ((options.write === true || parsedUri.originalLocatorPM === "git-write")?"write":"read")];
    
    var cachePath = PATH.join(pm.context.homeBasePath, "repository-cache", uri.replace(/[:@#]/g, "/").replace(/\/+/g, "/"));
    if (!PATH.existsSync(PATH.dirname(cachePath))) {
        FS_RECURSIVE.mkdirSyncRecursive(PATH.dirname(cachePath));
    }
    
    var done = Q.ref();
    
    if (!PATH.existsSync(cachePath)) {
        done = Q.when(done, function() {

            TERM.stdout.writenl("\0cyan(Cloning '" + uri + "' to '" + cachePath + "'.\0)");

            return GIT.interfaceForPath(cachePath).clone(uri, {
                verbose: true
            }).fail(function(err) {
                if (/remote error: access denied or repository not exported/.test(err.message)) {
                    TERM.stdout.writenl("\0red(" + "ERROR: Access denied or repository not exported. Maybe use -w to clone in write mode?" + "\0)");
                    return;
                } else {
                    throw err;
                }
            });
        });
    } else {
        done = Q.when(done, function() {

            TERM.stdout.writenl("\0cyan(Fetching '" + uri + "' to '" + cachePath + "'.\0)");

            return GIT.interfaceForPath(cachePath).fetch(uri, {
                verbose: true
            });
        });
    }

    done = Q.when(done, function() {

        TERM.stdout.writenl("\0cyan(Copying '" + cachePath + "' to '" + packagePath + "'.\0)");
        
        var deferred = Q.defer();
        
        EXEC("cp -R " + cachePath + "/ " + packagePath, function(err, stdout, stderr) {
            if (err) {
                deferred.reject(err);
                return;
            }
            deferred.resolve();
        });
        
        return deferred.promise;
    });

    if (parsedUri.vendor.rev) {
        done = Q.when(done, function() {

            TERM.stdout.writenl("\0cyan(Checking out '" + parsedUri.vendor.rev + "' at '" + packagePath + "'.\0)");

            return GIT.interfaceForPath(packagePath).checkout(parsedUri.vendor.rev);
        });
    }

    return done;
}
