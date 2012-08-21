
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const Q = require("sourcemint-util-js/lib/q");
const UTIL = require("sourcemint-util-js/lib/util");
const TERM = require("sourcemint-util-js/lib/term");
const EXEC = require("child_process").exec;
const SPAWN = require("child_process").spawn;


exports.interfaceForPath = function(path, options) {
    return new Interface(path, options);
}


var Interface = function(path, options) {
    this.path = path;
    this.options = UTIL.copy(options || {});
    if (typeof this.options.verbose === "undefined") {
        this.options.verbose = false;
    }
}

Interface.prototype.isRepository = function() {
    var self = this;
    return Q.call(function() {
        return PATH.existsSync(PATH.join(self.path, ".git"));
    });
}

Interface.prototype.status = function() {
    var self = this;
    return self.isRepository().then(function(isRepository) {
        if (!isRepository) {
            return {
                "type": false
            };
        }
        return self.callGit([
            "status"
        ]).then(function(result) {
            var info = {
                    "type": "git",
                    "ahead": false,
                    "dirty": true,
                    "tagged": false,
                    "remoteAhead": false
                },
                lines = result.split("\n"),
                index = 0;
            if(m = lines[index].match(/^# On branch (.*)$/)) {
                info.branch = m[1];
            } else
            if(m = lines[index].match(/^# Not currently on any branch.$/)) {
                info.branch = "rev";
            }

            index++;
            if(m = lines[index].match(/^# Your branch is ahead of /)) {
                info.ahead = true;
                index += 2;
            } else
            if(m = lines[index].match(/^# Your branch is behind /)) {
                info.behind = true;
                index += 2;
            }
            if(m = lines[index].match(/^nothing to commit \(working directory clean\)$/)) {
                info.dirty = false;
            }
            
            return self.callGit([
                 "rev-parse",
                 "HEAD"
            ]).then(function(result) {
                info.rev = result.replace(/\n$/, "");
                if (info.branch === "rev") {
                    info.branch = info.rev;
                }
                
                return self.callGit([
                     "log",
                     "--oneline",
                     "origin/" + info.branch + "..HEAD"
                ]).then(function(result) {
                    result = result.replace(/\n$/, "");
                    if (result) {
                        var lines = result.split("\n");
                        if (lines.length > 0) {
                            info.remoteAhead = lines.length;
                        }
                    }
                    return self.callGit([
                         "log",
                         "--oneline",
                         "--decorate",
                         "-n", "1"
                    ]).then(function(result) {
                        result = result.replace(/\n$/, "");
                        if (result) {
                            var m = result.match(/tag: ([^\,)]*)[,\)]/);
                            if (m) {
                                info.tagged = m[1];
                            }
                        }
                        return info;
                    }).fail(function(err) {
                        // Silence error (happens usually if 'origin' remote does not exist)
                        return info;
                    });
                });
            }).fail(function(err) {
                // Silence error (happens usually if 'origin' remote does not exist)
                return info;
            });
        });
    });
}

Interface.prototype.clone = function(url, options) {
    var self = this;
    options = options || {};
    options.cwd = options.cwd || PATH.dirname(self.path);
    if (PATH.existsSync(self.path)) {
        throw new Error("Error cloning git repository. Target path '" + self.path + "' already exists!");
    }
    return self.callGit([
        "clone",
        "--progress",
        url,
        PATH.basename(self.path)
    ], options).then(function(result) {
        // TODO: Detect more failure?
    });
}

Interface.prototype.fetch = function(url, options) {
    var self = this;
    options = options || {};
    options.cwd = options.cwd || self.path;
    return self.remotes().then(function(remotes) {
        var found = false;
        for (var remote in remotes) {
            if (url === remote || remotes[remote]["fetch-url"] === url) {
                found = remote;
                break;
            }
        }
        var done = Q.ref();
        if (!found) {
            if (options.setRemote) {
                remote = "origin";
                done = Q.when(done, function() {
                    return self.setRemote(remote, url)
                });
            } else {
                throw new Error("Cannot fetch from '" + url + "' for repository '" + self.path + "' as remote URI not found in remotes.");
            }
        }
        return Q.when(done, function() {
            return self.callGit([
                "fetch",
                remote
            ], options).then(function(result) {
                // TODO: Detect more failure?
                if (UTIL.trim(result) === "") {
                    return 304;
                }
                return 200;
            });
        });
    });
}


Interface.prototype.remotes = function() {
    var self = this;
    return self.callGit([
        "remote",
        "show"
    ]).then(function(result) {
        var done = Q.defer();
        var remotes = {};
        result.split("\n").map(function(remote) {
            if (! (remote = UTIL.trim(remote))) return;
            done = Q.when(done, function() {
               return self.callGit([
                   "remote",
                   "show",
                   "-n",
                   remote
               ]).then(function(result) {
                   remotes[remote] = {
                       "fetch-url": result.match(/Fetch URL: ([^\n]*)\n/)[1],
                       "push-url": result.match(/Push  URL: ([^\n]*)\n/)[1]
                   };
               });
            });
        });
        return Q.when(done, function() {
            return remotes;
        });
    });
}


Interface.prototype.setRemote = function(name, uri) {
    var self = this;
    return self.callGit([
        "remote",
        "set-url",
        "--push",
        name,
        uri
    ]).then(function(result) {
        // TODO: Detect more failure?
    });
}


Interface.prototype.pull = function(remote, ref) {
    var self = this;
    return self.callGit([
        "pull",
        remote,
        ref
    ], {
        verbose: true
    }).then(function(result) {
        // TODO: Detect more failure?
    });
}


Interface.prototype.containsRef = function(ref) {
    var self = this;
    return self.callGit([
        "branch",
        "--contains",
        ref
    ], {
        verbose: false
    }).then(function(result) {
        var branches = [];
        result.replace(/\n$/, "").split("\n").forEach(function(branch) {
            branches.push(branch.replace(/^\s*\*?\s*/, ""));
        });
        return branches;
    }, function(err) {
        if (/error: no such commit/.test(err.message)) {
            return false;
        }
        if (/error: malformed object name/.test(err.message)) {
            return false;
        }
        throw err;
    });
}


Interface.prototype.checkout = function(ref) {
    var self = this;
    return self.callGit([
        "checkout",
        ref
    ]).then(function(result) {
        // TODO: Detect more failure?
    });
}


Interface.prototype.tags = function() {
    var self = this;
    return self.isRepository().then(function(isRepository) {
        if (!isRepository) {
            return {
                "type": false
            };
        }
        return self.callGit([
            "tag"
        ]).then(function(result) {
            return {
                tags: UTIL.map(result.split("\n"), function(version) {
                    return UTIL.trim(version);
                }).filter(function(version) {
                    if (version === "") return false;
                    return true;
                })
            };
        });
    });
}

Interface.prototype.tag = function(tag) {
    var self = this;
    return self.isRepository().then(function(isRepository) {
        if (!isRepository) {
            return {
                "type": false
            };
        }
        return self.callGit([
            "tag",
            tag
        ]).then(function(result) {
            return self.tags().then(function(info) {
                if (!info.tags) {
                    throw new Error("Error tagging. No tags found when verifying!");
                }
                if (info.tags.indexOf(tag) === -1) {
                    throw new Error("Error tagging. New tag not found when verifying!");
                }
            });
        });
    });
}

Interface.prototype.push = function(options) {
    var self = this;
    ASSERT(typeof options.branch !== "undefined", "'options.branch' not set!");
    ASSERT(typeof options.remote !== "undefined", "'options.remote' not set!");
    return self.isRepository().then(function(isRepository) {
        if (!isRepository) {
            return {
                "type": false
            };
        }
        var args = [
            "push",
            options.remote,
            options.branch
        ];
        if (options.tags) {
            args.push("--tags");
        }
        return self.callGit(args).then(function(result) {
            // TODO: Verify that push was successful?
        });
    });
}

Interface.prototype.commit = function(message, options) {
    var self = this;
    return self.isRepository().then(function(isRepository) {
        if (!isRepository) {
            return {
                "type": false
            };
        }
        var done = Q.ref();
        if (options.add) {
            done = Q.when(done, function() {
                return self.callGit([
                    "add",
                    "."
                ]);
            });
        }
        return Q.when(done, function() {
            return self.callGit([
                "commit",
                "-m", message
            ]).then(function(result) {
                if (!/\d* files? changed,/.test(result)) {
                    throw new Error("Error committing: " + result);
                }
            });
        });
    });
}

Interface.prototype.callGit = function(procArgs, options) {
    var self = this;

    options = options || {};
    if (typeof options.verbose === "undefined") {
        options.verbose = self.options.verbose;
    }
    
    var deferred = Q.defer();

    if (options.verbose) TERM.stdout.writenl("\0cyan(Running: git " + procArgs.join(" ") + " (cwd: " + (options.cwd || self.path) + ")\0)");

    var proc = SPAWN("git", procArgs, {
        cwd: options.cwd || self.path,
        env: {
            GIT_SSH: PATH.join(__dirname, "git-ssh.sh")
        }
    });
    var buffer = "";

    proc.on("error", function(err) {
        deferred.reject(err);
    });
    
    proc.stdout.on("data", function(data) {
        if (options.verbose) {
            TERM.stdout.write(data.toString());
        }
        buffer += data.toString();
    });
    proc.stderr.on("data", function(data) {
        if (options.verbose) {
            TERM.stderr.write(data.toString());
        }
        buffer += data.toString();
    });
    proc.on("exit", function(code) {
        if (code !== 0) {
            deferred.reject(new Error("Git error: " + buffer));
            return;
        }
        if (/fatal/.test(buffer)) {
            deferred.reject(new Error("Git error: " + buffer));
            return;
        }
        deferred.resolve(buffer);
    });

    return deferred.promise;
}




/*
var UTIL = require("./util");
var SEMVER = require("./semver");
// Copyright 2009 Christoph Dorn
var Git = exports.Git = function(path) {
    if (!(this instanceof exports.Git))
        return new exports.Git(path);
    this.cache = {};
    this.path = path;
    this.checkInitialized();
}

Git.prototype.checkInitialized = function() {
    this.rootPath = null;
    if (PATH.existsSync(this.path)) {
        try {
            var result = this.runCommand('git rev-parse --git-dir');
            if(result && result.substr(0,27)!="fatal: Not a git repository") {
                this.rootPath = PATH.dirname(result);
                if(this.rootPath.valueOf()==".") {
                    this.rootPath = this.path.join(this.rootPath);
                }
            }
        } catch(e) {}
    }
    return this.initialized();
}

Git.prototype.initialized = function() {
    return (this.rootPath!==null);
}

Git.prototype.getType = function() {
    return "git";
}

Git.prototype.getPath = function() {
    return this.path;
}

Git.prototype.getRootPath = function() {
    if(!this.initialized()) return false;
    return this.rootPath;
}

Git.prototype.getPathPrefix = function() {
    var path = this.getRootPath().join(".").relative(this.getPath()).valueOf();
    if(path.substr(path.length-1,1)=="/") {
        path = path.substr(0, path.length-1);
    }
    return FILE.Path(path);
}

Git.prototype.init = function() {
    if(this.initialized()) {
        throw new GitError("Repository already initialized at: " + this.getPath());
    }
    this.getPath().mkdirs();
    this.runCommand("git init");
    if(!this.checkInitialized()) {
        throw new GitError("Error initializing repository at: " + this.getPath());
    }
}

Git.prototype.runCommand = function(command) {

    command = "cd " + this.path.valueOf() + "; " + command;
    
    var process = OS.popen(command);
    var result = process.communicate();
    var stdout = result.stdout.read();
    var stderr = result.stderr.read();
    if (result.status === 0 || (result.status==1 && !stderr)) {
        return UTIL.trim(stdout);
    }
    throw new GitError("Error running command (status: "+result.status+") '"+command+"' : "+stderr);
}


Git.prototype.getLatestVersion = function(majorVersion, path) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand('git tag -l "' + ((path)?path+"/":"") + 'v*"');
    if(!result) {
        return false;
    }
    var versions = UTIL.map(result.split("\n"), function(version) {
        if(path) {
            return UTIL.trim(version).substr(path.length+2);
        } else {
            return UTIL.trim(version).substr(1);
        }
    });
    return SEMVER.latestForMajor(versions, majorVersion);
}


Git.prototype.getLatestRevisionForBranch = function(branch) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }

    var result = this.runCommand('git log --no-color --pretty=format:"%H" -n 1 ' + branch);
    if(!result) {
        return false;
    }
    return UTIL.trim(result);
}

Git.prototype.getFileForRef = function(revision, path) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var path = this.getPathPrefix().join(path);
    if(path.substr(0,1)=="/") path = path.substr(1);
    var result = this.runCommand('git show ' + revision + ':' + path);
    if(!result) {
        return false;
    }
    return result;
}

Git.prototype.getRepositories = function() {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    if(this.cache.repositories) {
        return this.cache.repositories;
    }
    var result = this.runCommand('git remote show');
    if(!result) {
        return false;
    }
    var remotes = UTIL.trim(result).split("\n"),
        self = this,
        repositories = [];
    remotes.forEach(function(name) {
        result = self.runCommand('git remote show -n ' + name);
        repositories.push(new RegExp("^. remote " + name + "\n ( Fetch)? URL: ([^\n]*)\n").exec(result)[2]);
    });
    this.cache.repositories = repositories;
    return repositories;
}

Git.prototype.add = function(path) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git add " + OS.enquote(path));
    if(result!="") {
        throw new GitError("Error adding file at path: " + path);
    }
    return true;
}

Git.prototype.commit = function(message) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git commit -m " + OS.enquote(message));
    if(!result) {
        throw new GitError("Error comitting");
    }
    if(!/\d* files changed, \d* insertions\(\+\), \d* deletions\(-\)/g.test(result)) {
        throw new GitError("Error comitting: " + result);
    }
    // TODO: Parse result info
    return true;
}

Git.prototype.remoteAdd = function(name, url) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git remote add " + OS.enquote(name) + " " + OS.enquote(url));
    if(result!="") {
        throw new GitError("Error adding remote");
    }
    return true;
}

Git.prototype.push = function(name, branch) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git push " + OS.enquote(name) + " " + OS.enquote(branch));
    if(result!="") {
        throw new GitError("Error pusing");
    }
    return true;
}

Git.prototype.clone = function(url) {
    if(this.initialized()) {
        throw new GitError("Repository already initialized at path: " + this.getPath());
    }
    var result = this.runCommand("git clone " + OS.enquote(url) + " .");
    if(!/^Initialized empty Git repository/.test(result)) {
        throw new GitError("Error cloning repository from: " + url);
    }
    if(!this.checkInitialized()) {
        throw new GitError("Error verifying cloned repository at: " + this.getPath());
    }
    return true;
}


Git.prototype.branch = function(name, options) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    options = options || {};
    if(options.track) {
        var result = this.runCommand("git branch --track " + options.track + " " + name);
        var parts = name.split("/");
        if(result!="Branch "+options.track+" set up to track remote branch "+parts[1]+" from "+parts[0]+".") {
            throw new GitError("Error creating branch: " + result);
        }
        return true;
    } else {
        throw new GitError("NYI");
    }
}

Git.prototype.checkout = function(name) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git checkout " + name);
    if(result) {
        throw new GitError("Error checking out branch: " + result);
    }
    return true;
}

Git.prototype.getActiveBranch = function() {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git branch"),
        m;
    if(!result) {
        throw new GitError("Error listing branches");
    } else
    if(!(m = result.match(/\n?\*\s(\w*)\n?/))) {
        throw new GitError("Error parsing active branch");
    }
    return m[1];
}

Git.prototype.getBranches = function(remoteName) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git branch" + ((remoteName)?" -r":""));
    if(!result) {
        throw new GitError("Error listing branches");
    }
    var branches = [],
        m;
    result.split("\n").forEach(function(line) {
        if(remoteName) {
            if(m = line.match(/^\s*([^\/]*)\/(\w*)$/)) {
                if(m[1]==remoteName) {
                    branches.push(m[2]);
                }
            }
        } else {
            if(m = line.match(/^\*\s(\w*)$/)) {
                branches.push(m[1]);
            }
        }
    });
    return branches;
}


Git.prototype.getStatus = function() {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git status"),
        m;
    if(!result) {
        throw new GitError("Error listing status");
    }
    var info = {
            "ahead": false,
            "dirty": true
        },
        lines = result.split("\n"),
        index = 0;

    if(m = lines[index].match(/^# On branch (.*)$/)) {
        info.branch = m[1];
    }
    index++;

    if(m = lines[index].match(/^# Your branch is ahead of /)) {
        info.ahead = true;
        index += 2;
    }

    if(m = lines[index].match(/^nothing to commit \(working directory clean\)$/)) {
        info.dirty = false;
    }
    
    return info;
}



var GitError = exports.GitError = function(message) {
    this.name = "GitError";
    this.message = message;

    // this lets us get a stack trace in Rhino
    if (typeof Packages !== "undefined")
        this.rhinoException = Packages.org.mozilla.javascript.JavaScriptException(this, null, 0);
}
GitError.prototype = new Error();
*/