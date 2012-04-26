
const PATH = require("path");
const FS = require("fs");
const EXEC = require("child_process").exec;
const SPAWN = require("child_process").spawn;
const GIT = require("./git");

exports.install = function(packagePath, options, callback) {

    var procArgs = [
        "clone",
        options.locator,
        options.installPath
    ];

    console.log("git", procArgs.join(" "));

    var proc = SPAWN("git", procArgs);

    proc.stdout.on("data", function(data) {
        // TODO: Indicate that this is process output.
        process.stdout.write(data);
    });
    proc.stderr.on("data", function(data) {
        // TODO: Indicate that this is process output.
        process.stdout.write(data);
    });
    proc.on("exit", function(code) {
        if (code !== 0) {
            callback(new Error("'git' exited with: " + code));
            return;
        }
        callback(null);
    });
}

exports.status = function(pm, options) {
    return GIT.interfaceForPath(pm.context.package.path).status();
}
