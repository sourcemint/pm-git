
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
        return Q.ref();
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

            if (status === 200 || !PATH.existsSync(packagePath) || options.delete === true) {

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

exports.link = function(pm, options) {

    var packagePath = pm.context.package.path;

    var git = GIT.interfaceForPath(packagePath);

    return git.status().then(function(status) {
        if (status.type === "git") {
            TERM.stdout.writenl("\0red(" + "ERROR: Cannot link/clone source for package '" + packagePath + "'! It is already a git repository." + "\0)");
            return;
        }
        
        var repository = false;
        if (options.args[1]) {
            repository = options.args[1];
        } else {
            var repositories = pm.context.package.descriptor.json.repository;
            if (!repositories) {
                repositories = pm.context.package.descriptor.json.repositories;
            } else {
                repositories = [ repositories ];
            }
            if (repositories) {
                var repository = repositories[0];
                if (typeof repository === "object" && repository.url) {
                    repository = repository.url;
                }
            }
        }
        if (!repository) {
            repository = options.locator;
        }

        if (!repository) {
            TERM.stdout.writenl("\0red(" + "ERROR: Cannot determine source uri for package '" + packagePath + "'! Specify with SOURCE_URI. See `sm -h link`." + "\0)");
            return;
        }

        var parsedUri = URI_PARSER.parse(repository);

        if (!parsedUri.vendor || parsedUri.vendor.id !== "github.com") {
            TERM.stdout.writenl("\0red(" + "ERROR: " + "Only github.com URIs are supported at this time!" + "\0)");
            return;
        }
        
        var done = Q.ref();
        
        // Backup all existing dependencies.
        var backupPath = packagePath + "~backup-" + new Date().getTime();
        if (PATH.existsSync(packagePath)) {
            done = Q.when(done, function() {
                TERM.stdout.writenl("\0cyan(" + "Backing up '" + packagePath + "' to '" + backupPath + "'." + "\0)");
                return FS_RECURSIVE.osCopyDirRecursive(packagePath, backupPath);
            });
        }
        
        return Q.when(done, function() {

            options.locator = parsedUri.locators["git-write"];
            if (options.rev) {
                options.locator += "#" + options.rev;
            }
            options.delete = true;

            return pm.clone(options).then(function() {

                if (PATH.existsSync(backupPath)) {
                    var done = Q.ref();
                    [
                        "node_modules",
                        "mapped_packages"
                    ].map(function(dirname) {
                        if (PATH.existsSync(PATH.join(packagePath, dirname))) {
                            done = Q.when(done, function() {
                                return FS_RECURSIVE.osCopyDirRecursive(PATH.join(packagePath, dirname), PATH.join(backupPath, dirname));
                            });
                        }
                    });
                    return done;
                }
            }).then(function() {
                
                TERM.stdout.writenl("\0cyan(" + "Updating package: '" + packagePath + "\0)");
                
                var deferred = Q.defer();
                
                var args = [
                    "update",
                    "."
                ];

                var proc = SPAWN("sm", args, {
                    cwd: pm.context.package.path
                });

                proc.on("error", function(err) {
                    deferred.reject(err);
                });
                
                proc.stdout.on("data", function(data) {
                    TERM.stdout.write(data.toString());
                });
                proc.stderr.on("data", function(data) {
                    TERM.stderr.write(data.toString());
                });
                proc.on("exit", function(code) {
                    if (code !== 0) {
                        deferred.reject(new Error("sm error: " + buffer));
                        return;
                    }
                    deferred.resolve();
                });                    

                return deferred.promise;
            });

        }).fail(function(err) {
            TERM.stdout.writenl("\0red(" + "NOTE: " + "Original package was backed up to: " + backupPath + "\0)");
            throw err;
        }).then(function(err) {
            // TODO: Only delete packages in backupPath if identical to ones in cache.
            if (PATH.existsSync(backupPath)) {
                return FS_RECURSIVE.rmdirSyncRecursive(backupPath);
            }
        });
    });
}

