
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
    
    var done = Q.ref();
    
    var git = GIT.interfaceForPath(pm.context.package.path);

    if (options.latest) {
        done = Q.when(done, function() {
            // TODO: Make remote name configurable?
            return git.fetch("origin");
        });
    }

    return Q.when(done, function() {
        return git.status();
    });
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
    
    var status = false;
    
    if (!PATH.existsSync(cachePath)) {
        done = Q.when(done, function() {
            
            status = 200;            

            TERM.stdout.writenl("\0cyan(Cloning '" + uri + "' to '" + cachePath + "'.\0)");

            return GIT.interfaceForPath(cachePath).clone(uri, {
                verbose: true
            }).then(function() {
                return 200;
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
            
            if (options.cached) {

                TERM.stdout.writenl("\0yellow(SKIP: Fetching '" + uri + "' to '" + cachePath + "'.\0)");
                
            } else {

                TERM.stdout.writenl("\0cyan(Fetching '" + uri + "' to '" + cachePath + "'.\0)");
    
                return GIT.interfaceForPath(cachePath).fetch(uri, {
                    verbose: true
                }).then(function(code) {
                    
                    // TODO: More finer grained update checking. If branch has not changed report 304.
                    
                    status = code;
                });
            }
        });
    }
    
    return Q.when(done, function() {

        function gitStatus() {
            if (PATH.existsSync(packagePath)) {
                return GIT.interfaceForPath(packagePath).status();
            } else {
                return Q.ref();
            }
        }

        return gitStatus().then(function(gitStatus) {
            if (gitStatus && gitStatus.type === "git") {
                if (gitStatus.dirty || gitStatus.ahead) {
                    throw new Error("Cannot clone '" + uri + "' to '" + packagePath + "' as git repository at target is dirty or ahead.");
                }
                else if(gitStatus.rev != parsedUri.vendor.rev) {
                    throw new Error("Cannot clone '" + uri + "' to '" + packagePath + "' as git repository at target is on a different branch '" + gitStatus.branch + "'!");
                }
            }

            if (status === 200 || !PATH.existsSync(packagePath)) {
                
                if (PATH.existsSync(packagePath)) {
                    FS_RECURSIVE.rmdirSyncRecursive(packagePath);
                }
                
                FS_RECURSIVE.mkdirSyncRecursive(packagePath);

                TERM.stdout.writenl("\0cyan(Copying '" + cachePath + "' to '" + packagePath + "'.\0)");
                
                return FS_RECURSIVE.osCopyDirRecursive(cachePath, packagePath).then(function() {

                    TERM.stdout.writenl("\0cyan(Checking out '" + parsedUri.vendor.rev + "' at '" + packagePath + "'.\0)");
        
                    return GIT.interfaceForPath(packagePath).checkout(parsedUri.vendor.rev).then(function() {
                        return 200;
                    });
                }).fail(function(err) {
                    FS_RECURSIVE.rmdirSyncRecursive(packagePath);
                    throw err;
                });
            }

            TERM.stdout.writenl("  \0green(Not modified\0)");
            
            return 304;
        });
    });
}
