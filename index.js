'use strict';
 
var argv = require('minimist')(process.argv.slice(2));
const http = require('http');
const fs = require('fs');
const { spawn } = require("child_process");


var sessionCookie;

var targetHost = "";

var viewerFileName = "JViewer.jar"
var forceDownload = false;


var username = "ADMIN";
var password = "admin";


function replaceAll(str, find, replace) {
    return str.replace(new RegExp(find, 'g'), replace);
}

function makePOSTRequest(server, path, data, successCallback, failureCallback) {
    const options = {
        hostname: server,
        path: path,
        method: 'POST',
        timeout: 2500,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': data.length
        }
    };


    const req = http.request(options, (res) => {
        let body = '';

        res.on('data', (chunk) => {
            body += chunk;
        });

        res.on('end', () => {
            successCallback(body, res.statusCode);
        });

    }).on("error", (err) => {
        failureCallback(err);
        console.log("Error: ", err.message);
    });

    req.write(data);
    req.end();
}

function makeGETRequest(server, path, extraHeaders, successCallback, failureCallback) {
    const options = {
      hostname: server,
      path: path,
      method: 'GET',
      timeout: 2500,
      headers: extraHeaders
    }

    const req = http.request(options, (res) => {
        let body = '';

        res.on('data', (chunk) => {
            body += chunk;
        });

        res.on('end', () => {
            successCallback(body, res.statusCode);
        });

    }).on("error", (err) => {
        failureCallback(err);
        console.log("Error: ", err.message);
    });

    req.end();
}


function getSessionCookie(username, password) {
    return new Promise( resolve => {

        console.log("Getting session cookie...");
        makePOSTRequest(targetHost, "/rpc/WEBSES/create.asp",`WEBVAR_USERNAME=${username}&WEBVAR_PASSWORD=${password}`,function(data, statusCode) {
            var sessionCookieRegex = /'SESSION_COOKIE' : '.*'/g;
            var statusRegex = /HAPI_STATUS:\d/g;

            if (!sessionCookieRegex.test(data) && !statusRegex.test(data)) {
                console.error("Could not get session cookie - Unable to find required elements on page");
                process.exit(1);
            }

            var statusRegexMatches = data.match(statusRegex);

            if (statusRegexMatches.length != 1) {
                console.error("Could not get session cookie - Wrong number of status codes?");
                process.exit(1);
            }


            var status = statusRegexMatches[0].split(":")[1];

            if (status != 0) {
                console.error(`Could not get session cookie - Unexpected HAPI_STATUS code: ${status}`);
                process.exit(1);
            }


            var sessionRegexMatches = data.match(sessionCookieRegex);

            if (sessionRegexMatches.length != 1) {
                console.error("Could not get session cookie - Wrong number of session cookies?");
                process.exit(1);
            }

            sessionCookie = sessionRegexMatches[0].split(" : ")[1].slice(1, -1);

            console.log(`Got session cookie: "${sessionCookie}"`);
            resolve();
        }, function(error) {
            console.error("Could not get session cookie:");
            console.error(error);
            process.exit(1);
        });


    });
}

function getJNLP() {
    return new Promise( resolve => {

        console.log("Getting JNLP file...");
        makeGETRequest(targetHost, "/Java/jviewer.jnlp", {'Cookie' : `SessionCookie=${sessionCookie}`}, function(data, statusCode) {
            if (statusCode != 200) {
                console.error("Unable to get JNLP");
                console.error(data);
                process.exit(1);
            } else {
                console.log("Got JNLP file");
                resolve(data);
            }
        }, function(error) {
            console.log(error)

        });


    });
}


function getViewerURL(JNLP) {

    var url = "";

    var codebaseMatches = JNLP.match(/codebase=\".*\"/g);

    if (codebaseMatches.length != 1) {
        console.error("Could not get viewer URL from JNLP - Unable to find codebase");
        process.exit(1)
    }

    url += codebaseMatches[0].split(`"`)[1];

    var viewerMatches = JNLP.match(/<jar.*\/>/g);

    if (viewerMatches.length != 1) {
        console.error("Could not get viewer URL from JNLP - Unable to find JAR element");
        process.exit(1)
    }

    url += "/" + viewerMatches[0].split(`"`)[1];

    console.log(`Viewer URL: ${url}`);

    return url;
}

function downloadViewer(JNLP) {


    return new Promise( resolve => {
    
        var fileExists = fs.existsSync(viewerFileName);

        if (fileExists && !forceDownload) { 

            console.log("Viewer file already exists, we do not need to download it again");
            resolve();

        } else {

            var viewerURL = getViewerURL(JNLP);

            if (fileExists && forceDownload) {
                console.log("Removing old viewer file before downloading it again");
                fs.unlinkSync(viewerFileName);
            }


            var file = fs.createWriteStream(viewerFileName);

            console.log("Downloading viewer file...");

            var request = http.get(viewerURL, function(response) {
                response.pipe(file);
                file.on('finish', function() {
                    file.close(function() {
                        console.log("Done!")
                        resolve();
                    });
                });
            }).on('error', function(err) {
                fs.unlinkSync(viewerFileName);
                
                console.error("Could not download viewer file");
                console.error(err);
                process.exit(1)
            });

        }


    })
}

var viewerProcess;
var isViewerProcessRunning = false;
function runViewer(JNLP) {
    var argumentMatches = JNLP.match(/<argument>.*<\/argument>/g);

     if (argumentMatches.length == 0) {
        console.error("Could not get argument list from JNLP");
        process.exit(1)
    }

    var viewerArguments = ["-jar", viewerFileName];


    for (const viewerArgument of argumentMatches) {
        viewerArguments[viewerArguments.length] = viewerArgument.slice(10,-11);
    }

    console.log("Starting Viewer...");

    viewerProcess = spawn("java", viewerArguments);

    viewerProcess.stdout.on('data', (data) => {
        console.log(`Viewer STDOUT: ${replaceAll(data.toString(), "\n", "\n               ")}`);
        isViewerProcessRunning = true;
    });

    viewerProcess.stderr.on('data', (data) => {
        console.error(`Viewer STDERR: ${replaceAll(data.toString(), "\n", "\n               ")}`);
        isViewerProcessRunning = true;
    });

    viewerProcess.on('error', (error) => {
        console.error(`Viewer Error: ${replaceAll(error.message, "\n", "\n              ")}`);
        isViewerProcessRunning = true;
    });

    viewerProcess.on('close', (code) => {
        console.log(`Viewer process exited with code ${code}`);
        isViewerProcessRunning = false;
    });

}


function quit() {
    console.log("Quitting!");

    if (isViewerProcessRunning) {
        console.log("Killing viewer process...");
        viewerProcess.kill();
    }

    process.exit(0);
}



process.on('SIGTERM', () => {
    quit();
});
process.on('SIGINT', () => {
    quit();
});




async function main() {

    var argsUsername = (argv.u || argv.username);
    var argsPassword = (argv.p || argv.password);

    forceDownload = true == (argv.d || argv.alwaysDownload);

    var argsFileName = (argv.f || argv.viewerFile);

    var argsTarget = argv._[0];

    var showHelp = true == (argv.h || argv.help);

    if (showHelp || argsTarget == undefined) {
        console.log(`Usage: ipmiviewer server [options]

-u, --username\t\tset the username to use for authentication (the default is ADMIN)
-p, --password\t\tset the password to use for authentication (the default is admin)
-d, --alwaysDownload\talways download the viewer JAR, even if a copy exists already
-f, --viewerFile\tset the file name of the viewer JAR (the default is JViewer.jar)
-h, --help\t\tshow this information
`);

        process.exit(1);
    }

    targetHost = argsTarget;

    if (argsFileName != undefined) {
        viewerFileName = argsFileName;
    }

    if (argsUsername == undefined) {
        console.log(`Using the default username: ${username}`);
    } else {
        username = argsUsername;
    }

    if (argsPassword == undefined) {
        console.log(`Using the default password: ${password}`);
    } else {
        password = argsPassword;
    }

    await getSessionCookie(username, password);

    var JNLP = await getJNLP();

    await downloadViewer(JNLP);

    runViewer(JNLP);
}
main();