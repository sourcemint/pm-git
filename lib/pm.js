
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
const SEMVER = require("sourcemint-pinf-js/lib/semver");


exports.install = function(pm, options) {

    return exports.clone(pm, options);
    
}

exports.status = function(pm, options) {

    var git = GIT.interfaceForPath(pm.context.package.path, {
        verbose: options.verbose
    });

    return git.status().then(function(status) {
        if (status.type === "git") {

            var done = Q.ref();

            if (options.now) {
                done = Q.when(done, function() {
                    // TODO: Make remote name configurable?
                    return git.fetch("origin");
                });
            }

            return Q.when(done, function() {
                return git.remotes().then(function(remotes) {
                    if (remotes["origin"]) {
                        var parsedRemoteUri = URI_PARSER.parse(remotes["origin"]["push-url"]);
                        if (parsedRemoteUri.href === parsedRemoteUri.locators["git-write"]) {
                            status.writable = true;
                        }
                        return status;
                    }
                });
            });
        } else {
            return status;
        }            
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

            return GIT.interfaceForPath(cachePath, {
                verbose: options.verbose
            }).clone(uri, {
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
            
            function fetch() {
                TERM.stdout.writenl("\0cyan(Fetching '" + uri + "' to '" + cachePath + "'.\0)");
                
                return GIT.interfaceForPath(cachePath, {
                    verbose: options.verbose
                }).fetch(uri, {
                    verbose: true,
                    // NOTE: We assume we would only set a write URI where we had a read URI before (to the same location).
                    setRemote: true
                }).then(function(code) {
                    
                    // TODO: More finer grained update checking. If branch has not changed report 304.
                    
                    status = code;
                });
            }

            // Check for exact refs first. This is not affected by --cached cos if ref is not found we cannot do anything.
            if (parsedUri.vendor && parsedUri.vendor.rev && parsedUri.vendor.rev.length === 40) {

                TERM.stdout.writenl("\0cyan(Looking for ref '" + parsedUri.vendor.rev + "' in '" + cachePath + "'.\0)");

                return GIT.interfaceForPath(cachePath, {
                    verbose: options.verbose
                }).containsRef(parsedUri.vendor.rev).then(function(branches) {
                    if (!branches) {
                        // ref was not found so we need to fetch.
                        return fetch();
                    }
                    // ref was found so we can skip fetch.
                });

            } else
            if (options.cached) {
                // We may get here if a branch was specified instead of a ref.
                TERM.stdout.writenl("\0yellow(SKIP: Fetching '" + uri + "' to '" + cachePath + "' (due to --cached).\0)");
            } else {
                return fetch();
            }
        });
    }
    
    return Q.when(done, function() {

        function gitStatus() {
            if (PATH.existsSync(packagePath)) {
                return GIT.interfaceForPath(packagePath, {
                    verbose: options.verbose
                }).status();
            } else {
                return Q.ref();
            }
        }
        
        function deleteGitControl() {
            return Q.call(function() {
                if (PATH.existsSync(PATH.join(packagePath, ".git"))) {
                    TERM.stdout.writenl("\0cyan(Deleting git version control for package '" + packagePath + "' to put it into read only mode.\0)");
                    FS_RECURSIVE.rmdirSyncRecursive(PATH.join(packagePath, ".git"));
                }
            });
        }

        return gitStatus().then(function(gitStatus) {
            if (gitStatus && gitStatus.type === "git") {
                if (gitStatus.dirty || gitStatus.ahead || gitStatus.remoteAhead) {
                    throw new Error("Cannot clone '" + uri + "' to '" + packagePath + "' as git repository at target is dirty or ahead.");
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

                    var git = GIT.interfaceForPath(packagePath, {
                        verbose: options.verbose
                    });

                    return git.checkout(parsedUri.vendor.rev).then(function() {
                        // TODO: Better exact `ref` detection (in case `rev.length === 40` but us a branch name).
                        if (parsedUri.vendor.rev.length !== 40) {
                            // Assuming `parsedUri.vendor.rev` is a branch.

                            // See if `parsedUri.vendor.rev` is a tag, if it is we don't need to pull.
                            // TODO: Use `hasTag` call instead.
                            return git.tags().then(function(tags) {
                                if (tags.tags.indexOf(parsedUri.vendor.rev) !== -1) {
                                    // `parsedUri.vendor.rev` is a tag, not a branch.
                                    return;
                                }
                                // We did not check out an exact ref nor tag so we need to pull the branch.
                                TERM.stdout.writenl("\0cyan(Pulling latest changes at '" + packagePath + "'.\0)");
                                return git.pull("origin", parsedUri.vendor.rev);
                            });
                        }
                    }).then(function() {
                        if (options.readOnly === true) {
                            return deleteGitControl().then(function() {
                                return 200;
                            });
                        }
                        return 200;
                    }).fail(function(err) {

                        // TODO: Call `git.containsRef` before `git.checkout` so we can do this right away if not found.
                        if (/pathspec '[^']*' did not match any file\(s\) known to git/.test(err.message)) {

                            TERM.stdout.writenl("\0cyan(Exact revision '" + parsedUri.vendor.rev + "' not found. Resolving as a revision selector.\0)");

                            // The `parsedUri.vendor.rev` was not found.
                            // Let's resolve against tags as a revision selector instead.

                            return git.tags().then(function(tags) {

                                var tag = SEMVER.latestForMajor(tags.tags, parsedUri.vendor.rev);
                                if (!tag) {
                                    // We did not find a tag by treating `parsedUri.vendor.rev` as a revision selector.
                                    throw err;
                                }

                                TERM.stdout.writenl("\0cyan(Checking out '" + tag + "' at '" + packagePath + "'.\0)");

                                return git.checkout(tag);
                            });
                        } else {
                            throw err;
                        }
                    });
                }).fail(function(err) {
                    FS_RECURSIVE.rmdirSyncRecursive(packagePath);
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

    var packagePath = pm.context.package.path;

    var git = GIT.interfaceForPath(packagePath, {
        verbose: options.verbose
    });

    return git.status().then(function(status) {

        function repositoryFromDescriptor(descriptor) {
            var repositories = descriptor.json.repository;
            if (!repositories) {
                repositories = descriptor.json.repositories;
            } else {
                repositories = [ repositories ];
            }
            var url = false;
            if (repositories) {
                var repository = repositories[0];
                var url = false;
                if (typeof repository === "string") {
                    url = repository;
                } else if(repository.url) {
                    url = repository.url;
                }
            }
            return url;
        }
        
        var repository = false;
        if (options.args[1]) {
            repository = options.args[1];
        } else {
            var repository = repositoryFromDescriptor(pm.context.package.descriptor);
            if (!repository && options.npmStatusInfo && options.npmStatusInfo.descriptor) {
                repository = repositoryFromDescriptor({
                    json: options.npmStatusInfo.descriptor
                });
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

        if (status.type === "git") {
            return Q.call(function() {
                return git.remotes().then(function(remotes) {
                    if (!remotes["origin"]) {
                        TERM.stdout.writenl("\0cyan(" + "Setting origin remote for " + packagePath + "' to '" + parsedUri.locators["git-write"] + "'." + "\0)");
                        return git.setRemote("origin", parsedUri.locators["git-write"]);
                    } else {
                        var parsedRemoteUri = URI_PARSER.parse(remotes["origin"]["push-url"]);
                        if (parsedRemoteUri.href !== parsedUri.locators["git-write"]) {
                            TERM.stdout.writenl("\0cyan(" + "Setting origin remote for " + packagePath + "' to '" + parsedUri.locators["git-write"] + "'." + "\0)");
                            return git.setRemote("origin", parsedUri.locators["git-write"]);
                        } else {
                            TERM.stdout.writenl("\0cyan(" + "Origin remote uri for " + packagePath + "' is already set to '" + parsedUri.locators["git-write"] + "'." + "\0)");
                        }
                    }
                });
            });
        }
        
        var done = Q.ref();
        
        // Backup existing package.
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

                // TODO: Move this to `sourcemint-pm-sm/lib/commands/edit`.

                TERM.stdout.writenl("\0cyan(" + "Installing package: '" + packagePath + "\0)");
                
                var deferred = Q.defer();
                
                var args = [
                    "install",
                    "--dev",
                    "."
                ];
                
                if (options.now === true) {
                    args.push("--now");
                }
                if (options.verbose === true) {
                    args.push("--verbose");
                }

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
                        deferred.reject(new Error("sm error"));
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
            // TODO: Delete backupPath if identical to packages in cache.
        });
    });
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

