
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const EXEC = require("child_process").exec;
const SPAWN = require("child_process").spawn;
const GIT = require("./git");
const TERM = require("sourcemint-util-js/lib/term");
const UTIL = require("sourcemint-util-js/lib/util");
const Q = require("sourcemint-util-js/lib/q");
const URI_PARSER = require("sourcemint-pm-sm/lib/uri-parser");
const URL_PROXY_CACHE = require("sourcemint-util-js/lib/url-proxy-cache");
const FS_RECURSIVE = require("sourcemint-util-js/lib/fs-recursive");
const SEMVER = require("sourcemint-pinf-js/lib/semver");




// @since sm@0.3
exports.for = function(package) {
    return {
        download: function(fromLocator, toLocator, options) {

            var status = 500;

            return Q.call(function() {

                var parsedFromUri = URI_PARSER.parse(fromLocator.location);

                var uri = parsedFromUri.uris["git-write"] || parsedFromUri.uris["git-read"];
                if (!uri) {
                    throw new Error("Could not determine git write or read uri from '" + fromLocator.location + "'!");
                }
                function normalizeUri(uri) {
                    return uri.replace(/#[^#]*$/, "");
                }
                uri = normalizeUri(uri);

                var cachePath = toLocator.location.substring(0, toLocator.location.length - toLocator.version.length - 1);

                var git = GIT.interfaceForPath(cachePath, {
                    verbose: options.verbose,
                    debug: options.debug
                });

                return git.isRepository().then(function(isRepository) {
                    if (isRepository) {

                        function fetch() {

                            // TODO: Based on `options.now` don't fetch.
                            // TODO: Based on `options.time` track if called multiple times and only proceed once.
                            return git.fetch("origin", {
                                tags: true
                            }).then(function(code) {
                                // TODO: More finer grained update checking. If branch has not changed report 304.
                                status = code;
                            }).fail(function(err) {
                                TERM.stdout.writenl("\0red(" + err.message + "\0)");
                                TERM.stdout.writenl("\0red([sm] TODO: If remote origin URL is a read URL switch to write URL and try again. If still fails switch back to read URL.\0)");
                                throw err;
                            });
                        }

                        return git.containsRef(fromLocator.version).then(function(branches) {
                            if (!branches) {
                                // ref was not found so we need to fetch.
                                return fetch();
                            }
                            // ref was found so we can skip fetch.
                            status = 304;
                        }, function(err) {
                            // ref check failed as ref is likely a branch so we fetch.
                            return fetch();
                        });

                    } else {

                        if (PATH.existsSync(cachePath)) {
                            FS.rmdirSync(cachePath);
                        }

                        return git.clone(uri, {
                            // Always show clone progress as this can take a while.
                            verbose: true
                        }).then(function() {

                            // TODO: Write success file. If success file not present next time we access, re-clone.

                            // See if we can push. If not we set remote origin url to read.
                            if (parsedFromUri.uris["git-read"]) {
                                return git.canPush().then(function(canPush) {
                                    if (!canPush) {
                                        // We cannot push so we need to change the URI.
                                        return git.setRemote("origin", normalizeUri(parsedFromUri.uris["git-read"]));
                                    }
                                });
                            }
                        }).then(function() {
                            status = 200;
                        });
                    }
                }).then(function() {
                    return {
                        status: status,
                        cachePath: cachePath
                    };
                });
            });
        },
        extract: function(fromLocator, toLocator, options) {

            if (PATH.existsSync(toLocator.location) && !options.vcsOnly) {
                FS_RECURSIVE.rmdirSyncRecursive(toLocator.location);
            }
            if (!PATH.existsSync(toLocator.location)) {
                FS_RECURSIVE.mkdirSyncRecursive(toLocator.location);
            }

            var copyFrom = fromLocator.location;
            var copyTo = toLocator.location;
            if (options.vcsOnly) {
                copyFrom = PATH.join(fromLocator.location, ".git");
                copyTo = PATH.join(toLocator.location, ".git");
            }

            if (options.debug) TERM.stdout.writenl("\0cyan([sm]   Copying '" + copyFrom + "' to '" + copyTo + "'.\0)");

            // TODO: Use git export instead of copying everything.
            return FS_RECURSIVE.osCopyDirRecursive(copyFrom, copyTo).then(function() {

                if (options.vcsOnly) {
                    // TODO: Optimize.
                    if (PATH.existsSync(PATH.join(copyFrom, "../.gitignore"))) {
                        FS.writeFileSync(PATH.join(copyTo, "../.gitignore"), FS.readFileSync(PATH.join(copyFrom, "../.gitignore")));
                    }
                    if (PATH.existsSync(PATH.join(copyFrom, "../.gitmodules"))) {
                        FS.writeFileSync(PATH.join(copyTo, "../.gitmodules"), FS.readFileSync(PATH.join(copyFrom, "../.gitmodules")));
                    }
                }

                var git = GIT.interfaceForPath(fromLocator.location, {
                    verbose: options.debug
                });

                // TODO: Call this on `toLocator.location`?
                return git.remotes().then(function(remotes) {
                    var remoteBranches = [];
                    var branches = {};
                    if (remotes && remotes["origin"]) {
                        if (remotes["origin"].remoteBranches) {
                            remoteBranches = remotes["origin"].remoteBranches;
                        }
                        if (remotes["origin"].branches) {
                            branches = remotes["origin"].branches;                        
                        }
                    }

                    var git = GIT.interfaceForPath(toLocator.location, {
                        verbose: options.debug
                    });

                    // TODO: Init/update .gitmodules if applicable.

                    var done = Q.ref();

                    var ref = toLocator.version;

                    var isBranch = (ref === "master" || remoteBranches.indexOf(ref) !== -1)?true:false;
                    // If we found branch for `ref` in remoteBranches and there is no local tracking branch
                    // we setup a tracking branch.
                    if (isBranch) {
                        if (!branches[ref]) {
                            done = Q.when(done, function() {
                                if (options.verbose) TERM.stdout.writenl("\0cyan([sm]   Setting up remote tracking branch '" + ref + "' for '" + toLocator.location + "'.\0)");
                                return git.branch("origin/" + ref, {
                                    track: ref
                                });
                            });
                        }
                    } else {
                        // See if `toLocator.version` is a revision selector and if so resolve it.
                        done = Q.when(done, function() {
                            var git = GIT.interfaceForPath(fromLocator.location, {
                                verbose: options.debug
                            });
                            return git.containsRef(ref).then(function(branches) {
                                if (!branches) {
                                    // `ref` was not an exact git ref.
                                    return git.tags().then(function(tags) {
                                        if (tags.tags.indexOf(ref) !== -1) {
                                            if (options.verbose) TERM.stdout.writenl("\0cyan([sm]   Found '" + ref + "' to be a tag.\0)");
                                        } else if (tags.tags) {
                                            var tag = SEMVER.latestForMajor(SEMVER.versionsForTags(tags.tags), ref);
                                            if (tag) {
                                                if (options.verbose) TERM.stdout.writenl("\0cyan([sm]   Found '" + ref + "' to be a revision selector resolving to '" + tag + "'.\0)");
                                                ref = tag;
                                            }
                                        }
                                    });
                                }
                            });
                        });
                    }
                    return Q.when(done, function() {
                        if (options.verbose) TERM.stdout.writenl("\0cyan([sm]   Checking out '" + ref + "' at '" + toLocator.location + "'.\0)");
                        return git.checkout(ref, {
                            symbolic: options.vcsOnly || false
                        }).then(function() {
                            if (isBranch && options.now) {
                                // TODO: Don't need this as we are already fetched by now?
                                return git.pull("origin");
                            }
                        }).then(function() {
                            return 200;
                        });
                    });
                });
            });
        },
        install: function(path, options) {
            return Q.ref();
        },
        status: function(path, options) {
            var git = GIT.interfaceForPath(path, {
                verbose: options.debug
            });
            // TODO: Reorganize status info and provide complete local status to determine if ANYTHING has changed compared to 'origin'.
            //       This should also include extra remotes.
            return git.status().then(function(status) {
                if (status.type !== "git") {
                    return false;
                }
                var done = Q.ref();
                if (options.now) {
                    // TODO: Fetch latest in cache path and sync to here instead of fetching latest here.
                    done = Q.when(done, function() {
                        if (status.tracking) {
                            return git.fetch("origin");
                        } else if (status.noremote !== true) {
                            // TODO: `status.branch` should not be set if `status.branch === status.rev`.
                            if (status.branch !== status.rev) {
                                return git.fetch(["origin", status.branch]);
                            }
                        }
                    });
                    done = Q.when(done, function() {
                        return git.status().then(function(newStatus) {
                            status = newStatus;
                        });
                    });
                }
                return Q.when(done, function() {
                    return git.remotes().then(function(remotes) {
                        if (remotes["origin"]) {
                            status.remoteUri = remotes["origin"]["push-url"];
                            var parsedRemoteUri = URI_PARSER.parse(remotes["origin"]["push-url"]);
                            if (parsedRemoteUri.href === parsedRemoteUri.uris["git-write"]) {
                                status.writable = true;
                            }
                        }
                    });
                }).then(function() {
                    return status;
                });
            });
        }
    };
}





exports.install = function(pm, options) {

throw new Error("DEPRECATED");

    return exports.clone(pm, options);
    
}


exports.getLookupApiForPathLocation = function(pm, path, location) {

    var git = GIT.interfaceForPath(path);

    return git.isRepository().then(function(isRepository) {
        if (isRepository) {
            return git;
        }

        if (!location) return false;
        var parsedUri = URI_PARSER.parse(location);
        if (!parsedUri || !parsedUri.locators || !parsedUri.locators["git-write"]) return false;

        var uri = parsedUri.locators["git-write"];
        var cachePath = PATH.join(pm.context.homeBasePath, "repository-cache", uri.replace(/[:@#]/g, "/").replace(/\/+/g, "/"));
        if (!PATH.existsSync(cachePath)) return false;

        return GIT.interfaceForPath(cachePath);
    });
}


exports.status = function(pm, options) {

    var git = GIT.interfaceForPath(pm.context.package.path, {
        verbose: options.debug
    });

    function completeStatus(status) {
        var done = Q.ref();

        if (options.now) {
            done = Q.when(done, function() {
                if (status.tracking) {
                    return git.fetch("origin", {
                        verbose: options.verbose
                    });
                } else if (status.noremote !== true) {
                    // TODO: `status.branch` should not be set if `status.branch === status.rev`.
                    if (status.branch !== status.rev) {
                        return git.fetch(["origin", status.branch], {
                            verbose: options.verbose
                        });
                    }
                }
            });
            done = Q.when(done, function() {
                return git.status().then(function(newStatus) {
                    status = newStatus;
                });
            });
        }

        return Q.when(done, function() {
            return git.remotes().then(function(remotes) {
                if (remotes["origin"]) {
                    status.remoteUri = remotes["origin"]["push-url"];
                    var parsedRemoteUri = URI_PARSER.parse(remotes["origin"]["push-url"]);
                    if (parsedRemoteUri.href === parsedRemoteUri.locators["git-write"]) {
                        status.writable = true;
                    }
                }
            });
        }).then(function() {
            return status;
        });
    }

    return git.status().then(function(status) {

        if (status.type === "git") {
            return completeStatus(status);
        } else {

            // Our repo is not a git repo so lets check if we have a cached git repo and return that info.
            if (options.locator) {
                try {
                    var parsedUri = URI_PARSER.parse(options.locator);
                    if (parsedUri) {

                        var uri = parsedUri.locators["git-write"];
                        var cachePath = PATH.join(pm.context.homeBasePath, "repository-cache", uri.replace(/[:@#]/g, "/").replace(/\/+/g, "/"));

                        if (PATH.existsSync(cachePath)) {

                            git = GIT.interfaceForPath(cachePath, {
                                verbose: options.debug
                            });
                            return git.status().then(completeStatus).then(function(status) {
                                status.fromCache = true;
                                return status;
                            });
                        }
                    }
                } catch(err) {}
            }

            return status;
        }
    });
}

exports.clone = function(pm, options) {

throw new Error("DEPRECATED");

    options = options || {};

    ASSERT(typeof options.locator !== "undefined", "'options.locator' required!");

    var packagePath = pm.context.package.path;

    var parsedUri = URI_PARSER.parse(options.locator);

    if (!parsedUri.vendor || parsedUri.vendor.id !== "github.com") {
        TERM.stdout.writenl("\0red(" + "ERROR: " + "Only github.com URIs are supported at this time!" + "\0)");
        return Q.ref();
    }

    var uri = parsedUri.locators["git-write"];

    var cachePath = PATH.join(pm.context.homeBasePath, "repository-cache", uri.replace(/[:@#]/g, "/").replace(/\/+/g, "/"));
    if (!PATH.existsSync(PATH.dirname(cachePath))) {
        FS_RECURSIVE.mkdirSyncRecursive(PATH.dirname(cachePath));
    }
    
    var done = Q.ref();
    
    var status = false;
    
    if (!PATH.existsSync(cachePath)) {
        done = Q.when(done, function() {

            status = 200;

            if (options.verbose) TERM.stdout.writenl("\0cyan(Cloning '" + uri + "' to '" + cachePath + "'.\0)");

            var git = GIT.interfaceForPath(cachePath, {
                verbose: options.debug
            });

            return git.clone(uri, {
                verbose: options.verbose
            }).then(function() {
                // See if we can push. If not we set remote origin url to read.
                return git.canPush().then(function(canPush) {
                    if (!canPush) {
                        // We cannot push so we need to change the URI.
                        uri = parsedUri.locators["git-read"];
                        return git.setRemote("origin", uri);
                    }
                });
            }).then(function() {
                return 200;
            }).fail(function(err) {
                if (/remote error: access denied or repository not exported/.test(err.message)) {
                    TERM.stdout.writenl("\0red(" + err.message + "\0)");
                    TERM.stdout.writenl("\0red([sm] ERROR: While cloning '" + uri + "'.\0)");
                    return;
                } else {
                    throw err;
                }
            });
        });
    } else {
        done = Q.when(done, function() {

            function fetch() {
                if (options.verbose) TERM.stdout.writenl("\0cyan(Fetching '" + uri + "' to '" + cachePath + "'.\0)");

                return GIT.interfaceForPath(cachePath, {
                    verbose: options.verbose
                }).fetch("origin", {
                    tags: true
                }).then(function(code) {

                    // TODO: More finer grained update checking. If branch has not changed report 304.

                    status = code;

                }).fail(function(err) {
                    TERM.stdout.writenl("\0red(" + err.message + "\0)");
                    TERM.stdout.writenl("\0red([sm] TODO: If remote origin URL is a read URL switch to write URL and try again. If still fails switch back to read URL.\0)");
                    throw err;
                });
            }

            // Check for exact refs first. This is not affected by --now cos if ref is not found we cannot do anything.
            if (parsedUri.vendor && parsedUri.vendor.rev && parsedUri.vendor.rev.length === 40) {

                if (options.verbose) TERM.stdout.writenl("\0cyan(Looking for ref '" + parsedUri.vendor.rev + "' in '" + cachePath + "'.\0)");

                return GIT.interfaceForPath(cachePath, {
                    verbose: options.debug
                }).containsRef(parsedUri.vendor.rev).then(function(branches) {
                    if (!branches) {
                        // ref was not found so we need to fetch.
                        return fetch();
                    }
                    // ref was found so we can skip fetch.
                });

            } else
            if (!options.now) {
                // We may get here if a branch was specified instead of a ref.
                if (options.verbose) TERM.stdout.writenl("\0yellow(SKIP: Fetching '" + uri + "' to '" + cachePath + "'.\0)");
            } else {
                return fetch();
            }
        });
    }
    
    return Q.when(done, function() {

        function fetchGitStatus(path) {
            if (PATH.existsSync(path || packagePath)) {
                return GIT.interfaceForPath(path || packagePath, {
                    verbose: options.debug
                }).status();
            } else {
                return Q.ref();
            }
        }
        
        function deleteGitControl() {
            return Q.call(function() {
                if (PATH.existsSync(PATH.join(packagePath, ".git"))) {
                    if (options.verbose) TERM.stdout.writenl("\0cyan(Deleting git version control for package '" + packagePath + "' to put it into read only mode.\0)");
                    FS_RECURSIVE.rmdirSyncRecursive(PATH.join(packagePath, ".git"));
                }
            });
        }

        return fetchGitStatus().then(function(gitStatus) {
            if (gitStatus && gitStatus.type === "git") {
                if (gitStatus.dirty || gitStatus.ahead) {
                    throw new Error("Cannot clone '" + uri + "' to '" + packagePath + "' as git repository at target is dirty or ahead.");
                }
                if (options.vcsOnly) {
                    return 304;
                }
            }

            if (status === 200 || !PATH.existsSync(packagePath) || options.delete || options.vcsOnly) {

                if (PATH.existsSync(packagePath) && !options.vcsOnly) {
                    FS_RECURSIVE.rmdirSyncRecursive(packagePath);
                }

                if (!PATH.existsSync(packagePath)) {
                    FS_RECURSIVE.mkdirSyncRecursive(packagePath);
                }

                var copyFrom = cachePath;
                var copyTo = packagePath;

                if (options.vcsOnly) {
                    copyFrom = PATH.join(cachePath, ".git");
                    copyTo = PATH.join(packagePath, ".git");
                }

                if (options.verbose) TERM.stdout.writenl("\0cyan(Copying '" + copyFrom + "' to '" + copyTo + "'.\0)");

                return FS_RECURSIVE.osCopyDirRecursive(copyFrom, copyTo).then(function() {

                    return fetchGitStatus(cachePath).then(function(gitStatus) {

                        var git = GIT.interfaceForPath(packagePath, {
                            verbose: options.debug
                        });

                        var done = Q.ref();

                        var ref = parsedUri.vendor.rev;

                        var isBranch = (ref === "master" || gitStatus.remoteBranches.indexOf(ref) !== -1)?true:false;
                        // If we found branch for `ref` in remoteBranches and there is no local tracking branch
                        // we setup a tracking branch.
                        if (isBranch) {
                            if (!gitStatus.branches[ref]) {
                                done = Q.when(done, function() {

                                    if (options.verbose) TERM.stdout.writenl("\0cyan(Setting up remote tracking branch.\0)");

                                    return git.branch("origin/" + ref, {
                                        track: ref
                                    });
                                });
                            }
                        } else {
                            // See if `parsedUri.vendor.rev` is a revision selector and if so resolve it.
                            done = Q.when(done, function() {
                                return GIT.interfaceForPath(cachePath, {
                                    verbose: options.debug
                                }).containsRef(ref).then(function(branches) {
                                    if (!branches) {
                                        // `ref` was not an exact git ref.
                                        return GIT.interfaceForPath(cachePath, {
                                            verbose: options.debug
                                        }).tags().then(function(tags) {
                                            if (tags.tags.indexOf(ref) !== -1) {
                                                if (options.verbose) TERM.stdout.writenl("\0cyan(Found '" + ref + "' to be a tag.\0)");
                                            } else if (tags.tags) {
                                                var tag = SEMVER.latestForMajor(SEMVER.versionsForTags(tags.tags), ref);
                                                if (tag) {
                                                    if (options.verbose) TERM.stdout.writenl("\0cyan(Found '" + ref + "' to be a revision selector resolving to '" + tag + "'.\0)");
                                                    ref = tag;
                                                }
                                            }
                                        });
                                    }
                                });
                            });
                        }

                        return Q.when(done, function() {

                            if (options.verbose) TERM.stdout.writenl("\0cyan(Checking out '" + ref + "' at '" + packagePath + "'.\0)");

                            return git.checkout(ref, {
                                symbolic: options.vcsOnly || false
                            }).then(function() {

                                if (isBranch && options.now) {
                                    return git.pull("origin");
                                }

                            }).then(function() {
                                if (options.readOnly === true) {
                                    return deleteGitControl().then(function() {
                                        return 200;
                                    });
                                }
                                return 200;
                            });
                        });
                    });
                }).fail(function(err) {
                    FS_RECURSIVE.rmdirSyncRecursive(copyTo);
                    throw err;
                });
            }
            
            if (options.verbose) TERM.stdout.writenl("  \0green(Not modified\0)");
            
            if (options.readOnly === true) {
                return deleteGitControl().then(function() {
                    return 304;
                });
            }

            return 304;
        });
    });
}

exports.edit = function(pm, options) {

throw new Error("DEPRECATED");

    options = options || {};

    ASSERT(typeof options.node !== "undefined", "'options.node' required!");

    var node = options.node;

    if (node.status.status.vcs) {
        TERM.stdout.writenl("\0red([sm] ERROR: Package '" + node.status.status.relpath + "' is already in edit mode!\0)");
        var deferred = Q.defer();
        deferred.reject(true);
        return deferred.promise;
    }

    var sourceUri = options.args[1] || (node.status.locator && node.status.locator.location) || node.status.status.repositoryUri;

    if (!sourceUri) {
        TERM.stdout.writenl("\0red([sm] ERROR: No source URI found for package.\0)");
        TERM.stdout.writenl("\0red([sm] WORKAROUND: Specify source URI as third argument to `sm edit`.\0)");
        var deferred = Q.defer();
        deferred.reject(true);
        return deferred.promise;
    }

    var parsedUri = URI_PARSER.parse(sourceUri);

    var parsedRepoUri = false;
    try {
        parsedRepoUri = URI_PARSER.parse((node.status.locator && node.status.locator.location) || node.status.status.repositoryUri);
    } catch(err) {}

    if (!parsedUri.vendor || parsedUri.vendor.id !== "github.com") {
        TERM.stdout.writenl("\0red([sm] ERROR: Only github.com source URIs are supported at this time!\0)");
        var deferred = Q.defer();
        deferred.reject(true);
        return deferred.promise;
    }

    var git = GIT.interfaceForPath(node.path, {
        verbose: options.debug
    });

    var done = Q.ref();

    if (!node.status.status.vcs) {
        done = Q.when(done, function() {
            // Clone source and copy `.git` dir into package.
            if (options.verbose) TERM.stdout.writenl("\0cyan(Clone source and copy '.git' dir into package.\0)");

            var opts = UTIL.copy(options);
            delete opts.node;
            opts.forceClone = true;
            opts.readOnly = false;
            opts.vcsOnly = true;
            opts.now = true;

            // Try and clone exact version/ref.
            var locator = parsedUri.locators["git-write"];
            var version = null;
            if (parsedUri.vendor.rev !== "master") {
                version = parsedUri.vendor.rev;
            } else
            if (node.status.status.version) {
                version = node.status.status.version;
            }
            opts.locator = locator;
            if (version) {
                opts.locator += "#" + version;
            }

            return pm.clone(opts).fail(function(err) {
                TERM.stdout.writenl("\0yellow(" + err.message + "\0)");
                TERM.stdout.writenl("\0yellow([sm] WARNING: Checkout of '" + version + "' failed. Falling back to 'master'.\0)");
                opts.locator = locator;
                return pm.clone(opts);
            });
        });
    }

    return done;
}


/*

Git stash syncing:

  http://stackoverflow.com/questions/1550378/is-it-possible-to-push-a-git-stash-to-a-remote-repository
      
    cd from1
    git send-pack ../to $(for sha in $(git rev-list -g stash); \
    do echo $sha:refs/heads/stash_$sha; done)
    cd ../to
    for a in $(git rev-list --no-walk --glob='refs/heads/stash_*'); 
    do 
        git checkout $a && 
        git reset HEAD^ && 
        git stash save "$(git log --format='%s' -1 HEAD@{1})"
    done
    git branch -D $(git branch|cut -c3-|grep ^stash_)  

  Will always sync all stashes and add as new on receiving repo (even if already exists).
  Can sync from multiple source repos to one "master" repo.
  Need to run post-sync script that removes duplicate stashes and renames them if applicable.

*/

