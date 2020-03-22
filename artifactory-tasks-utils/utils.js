const fs = require('fs-extra');
const tl = require('azure-pipelines-task-lib/task');
const path = require('path');
const execSync = require('child_process').execSync;
const toolLib = require('azure-pipelines-tool-lib/tool');
const clientHandlers = require('typed-rest-client/Handlers');
const localTools = require('./tools');
const yaml = require('js-yaml');

const fileName = getCliExecutableName();
const toolName = 'jfrog';
const btPackage = 'jfrog-cli-' + getArchitecture();
const jfrogFolderPath = encodePath(path.join(tl.getVariable('Agent.WorkFolder'), '_jfrog'));
const jfrogCliVersion = '1.35.1';
const pluginVersion = '1.8.1';
const buildAgent = 'artifactory-azure-devops-extension';
const customCliPath = encodePath(path.join(jfrogFolderPath, 'current', fileName)); // Optional - Customized jfrog-cli path.
const jfrogCliBintrayDownloadUrl =
    'https://api.bintray.com/content/jfrog/jfrog-cli-go/' + jfrogCliVersion + '/' + btPackage + '/' + fileName + '?bt_package=' + btPackage;
const buildToolsConfigVersion = 1;

let cliConfigCommand = 'rt c';
let runTaskCbk = null;

module.exports = {
    executeCliTask: executeCliTask,
    executeCliCommand: executeCliCommand,
    downloadCli: downloadCli,
    cliJoin: cliJoin,
    quote: quote,
    addArtifactoryCredentials: addArtifactoryCredentials,
    addStringParam: addStringParam,
    addBoolParam: addBoolParam,
    fixWindowsPaths: fixWindowsPaths,
    validateSpecWithoutRegex: validateSpecWithoutRegex,
    encodePath: encodePath,
    getArchitecture: getArchitecture,
    isToolExists: isToolExists,
    buildCliArtifactoryDownloadUrl: buildCliArtifactoryDownloadUrl,
    createAuthHandlers: createAuthHandlers,
    configureCliServer: configureCliServer,
    deleteCliServers: deleteCliServers,
    writeSpecContentToSpecPath: writeSpecContentToSpecPath,
    stripTrailingSlash: stripTrailingSlash,
    determineCliWorkDir: determineCliWorkDir,
    createBuildToolConfigFile: createBuildToolConfigFile,
    assembleBuildToolServerId: assembleBuildToolServerId,
    appendBuildFlagsToCliCommand: appendBuildFlagsToCliCommand
};

// Url and AuthHandlers are optional. Using jfrogCliBintrayDownloadUrl by default.
function executeCliTask(runTaskFunc, cliDownloadUrl, cliAuthHandlers) {
    process.env.JFROG_CLI_HOME = jfrogFolderPath;
    process.env.JFROG_CLI_OFFER_CONFIG = false;
    process.env.JFROG_CLI_USER_AGENT = buildAgent + '/' + pluginVersion;
    // If unspecified, use the default cliDownloadUrl of Bintray.
    if (!cliDownloadUrl) {
        cliDownloadUrl = jfrogCliBintrayDownloadUrl;
        cliAuthHandlers = [];
    }

    runTaskCbk = runTaskFunc;
    getCliPath(cliDownloadUrl, cliAuthHandlers)
        .then(cliPath => {
            runCbk(cliPath);
            collectEnvVarsIfNeeded(cliPath);
        })
        .catch(error => tl.setResult(tl.TaskResult.Failed, 'Error occurred while executing task:\n' + error));
}

// Url and AuthHandlers are optional. Using jfrogCliBintrayDownloadUrl by default.
function getCliPath(cliDownloadUrl, cliAuthHandlers) {
    return new Promise(function(resolve, reject) {
        let cliDir = toolLib.findLocalTool(toolName, jfrogCliVersion);
        if (fs.existsSync(customCliPath)) {
            tl.debug('Using cli from custom cli path: ' + customCliPath);
            resolve(customCliPath);
        } else if (cliDir) {
            let cliPath = path.join(cliDir, fileName);
            tl.debug('Using existing versioned cli path: ' + cliPath);
            resolve(cliPath);
        } else {
            const errMsg = generateDownloadCliErrorMessage(cliDownloadUrl);
            createCliDirs();
            return downloadCli(cliDownloadUrl, cliAuthHandlers)
                .then(cliPath => resolve(cliPath))
                .catch(error => reject(errMsg + '\n' + error));
        }
    });
}

function buildCliArtifactoryDownloadUrl(rtUrl, repoName) {
    if (rtUrl.slice(-1) !== '/') {
        rtUrl += '/';
    }
    return rtUrl + repoName + '/' + jfrogCliVersion + '/' + btPackage + '/' + fileName;
}

function createAuthHandlers(artifactoryService) {
    let artifactoryUser = tl.getEndpointAuthorizationParameter(artifactoryService, 'username', true);
    let artifactoryPassword = tl.getEndpointAuthorizationParameter(artifactoryService, 'password', true);
    let artifactoryAccessToken = tl.getEndpointAuthorizationParameter(artifactoryService, 'apitoken', true);

    // Check if Artifactory should be accessed using access-token.
    if (artifactoryAccessToken) {
        return [new clientHandlers.BearerCredentialHandler(artifactoryAccessToken)];
    }

    // Check if Artifactory should be accessed anonymously.
    if (artifactoryUser === '') {
        return [];
    }

    // Use basic authentication.
    return [new clientHandlers.BasicCredentialHandler(artifactoryUser, artifactoryPassword)];
}

function generateDownloadCliErrorMessage(downloadUrl) {
    let errMsg = 'Failed while attempting to download JFrog CLI from ' + downloadUrl + '. ';
    if (downloadUrl === jfrogCliBintrayDownloadUrl) {
        errMsg +=
            "If this build agent cannot access the internet, you may use the 'Artifactory Tools Installer' task, to download JFrog CLI through an Artifactory repository, which proxies " +
            jfrogCliBintrayDownloadUrl +
            '. You ';
    } else {
        errMsg += 'If the chosen Artifactory Service cannot access the internet, you ';
    }
    errMsg +=
        'may also manually download version ' + jfrogCliVersion + ' of JFrog CLI and place it on the agent in the following path: ' + customCliPath;
    return errMsg;
}

/**
 * Execute provided CLI command in a child process. In order to receive execution's stdout, pass stdio=null.
 * @param {string} cliCommand
 * @param {string} runningDir
 * @param {string|Array} stdio - stdio to use for CLI execution.
 * @returns {Buffer|string} - execSync output.
 * @throws In CLI execution failure.
 */
function executeCliCommand(cliCommand, runningDir, stdio) {
    if (!fs.existsSync(runningDir)) {
        throw "JFrog CLI execution path doesn't exist: " + runningDir;
    }
    if (!cliCommand) {
        throw 'Cannot execute empty Cli command.';
    }
    try {
        if (!stdio) {
            stdio = [0, 1, 2];
        }
        tl.debug('Executing cliCommand: ' + cliCommand);
        return execSync(cliCommand, { cwd: runningDir, stdio: stdio });
    } catch (ex) {
        // Error occurred
        let errorMsg = ex.toString().replace(/--password=".*"/g, '--password=***');
        throw errorMsg.replace(/--access-token=".*"/g, '--access-token=***');
    }
}

/**
 * Add a new server to the CLI config.
 * @returns {Buffer|string}
 * @throws In CLI execution failure.
 */
function configureCliServer(artifactory, serverId, cliPath, buildDir) {
    let artifactoryUrl = tl.getEndpointUrl(artifactory);
    let artifactoryUser = tl.getEndpointAuthorizationParameter(artifactory, 'username', true);
    let artifactoryPassword = tl.getEndpointAuthorizationParameter(artifactory, 'password', true);
    let artifactoryAccessToken = tl.getEndpointAuthorizationParameter(artifactory, 'apitoken', true);
    let cliCommand = cliJoin(cliPath, cliConfigCommand, quote(serverId), '--url=' + quote(artifactoryUrl), '--interactive=false');
    if (artifactoryAccessToken) {
        // Add access-token if required.
        cliCommand = cliJoin(cliCommand, '--access-token=' + quote(artifactoryAccessToken));
    } else {
        // Add username and password.
        cliCommand = cliJoin(cliCommand, '--user=' + quote(artifactoryUser), '--password=' + quote(artifactoryPassword));
    }
    executeCliCommand(cliCommand, buildDir);
}

/**
 * Remove servers from the cli config.
 * @returns (Buffer|string) CLI execution output.
 * @throws In CLI execution failure.
 */
function deleteCliServers(cliPath, buildDir, serverIdArray) {
    let deleteServerIDCommand;
    for (let i = 0, len = serverIdArray.length; i < len; i++) {
        deleteServerIDCommand = cliJoin(cliPath, cliConfigCommand, 'delete', quote(serverIdArray[i]), '--interactive=false');
        // This operation throws an exception in case of failure.
        executeCliCommand(deleteServerIDCommand, buildDir);
    }
}

/**
 * Write file-spec to a file, based on the provided specSource input.
 * Tasks which use this function, must have PathInput named 'file', and input named 'taskConfiguration' determining the source of file-spec content.
 * File-spec content is written to provided specPath.
 * @param specSource - Value of 'file' uses PathInput 'file', value of 'taskConfiguration' uses input of 'fileSpec'.
 * @param specPath - File destination for the file-spec.
 * @throws - On input read error, or write-file error.
 */
function writeSpecContentToSpecPath(specSource, specPath) {
    let fileSpec;
    if (specSource === 'file') {
        let specInputPath = tl.getPathInput('file', true, true);
        console.log('Using file spec located at ' + specInputPath);
        fileSpec = fs.readFileSync(specInputPath, 'utf8');
    } else if (specSource === 'taskConfiguration') {
        fileSpec = tl.getInput('fileSpec', true);
    } else {
        throw 'Failed creating File-Spec, since the provided File-Spec source value is invalid.';
    }
    fileSpec = fixWindowsPaths(fileSpec);
    validateSpecWithoutRegex(fileSpec);
    console.log('Using file spec:');
    console.log(fileSpec);
    // Write provided fileSpec to file
    tl.writeFile(specPath, fileSpec);
}

function cliJoin() {
    let command = '';
    for (let i = 0; i < arguments.length; ++i) {
        let arg = arguments[i];
        if (arg.length > 0) {
            command += command === '' ? arg : ' ' + arg;
        }
    }
    return command;
}

function quote(str) {
    return '"' + str + '"';
}

function addArtifactoryCredentials(cliCommand, artifactoryService) {
    let artifactoryUser = tl.getEndpointAuthorizationParameter(artifactoryService, 'username', true);
    let artifactoryPassword = tl.getEndpointAuthorizationParameter(artifactoryService, 'password', true);
    let artifactoryAccessToken = tl.getEndpointAuthorizationParameter(artifactoryService, 'apitoken', true);

    // Check if should use Access Token.
    if (artifactoryAccessToken) {
        return cliJoin(cliCommand, '--access-token=' + quote(artifactoryAccessToken));
    }

    // Check if Artifactory should be accessed anonymously.
    if (artifactoryUser === '') {
        artifactoryUser = 'anonymous';
        return cliJoin(cliCommand, '--user=' + quote(artifactoryUser));
    }

    return cliJoin(cliCommand, '--user=' + quote(artifactoryUser), '--password=' + quote(artifactoryPassword));
}

function addStringParam(cliCommand, inputParam, cliParam) {
    let val = tl.getInput(inputParam, false);
    if (val) {
        cliCommand = cliJoin(cliCommand, '--' + cliParam + '=' + quote(val));
    }
    return cliCommand;
}

function addBoolParam(cliCommand, inputParam, cliParam) {
    let val = tl.getBoolInput(inputParam, false);
    cliCommand = cliJoin(cliCommand, '--' + cliParam + '=' + val);
    return cliCommand;
}

function logCliVersion(cliPath) {
    let cliCommand = cliJoin(cliPath, '--version');
    try {
        let res = execSync(cliCommand);
        let detectedVersion = String.fromCharCode
            .apply(null, res)
            .split(' ')[2]
            .trim();
        console.log('JFrog CLI version: ' + detectedVersion);
    } catch (ex) {
        console.error('Failed to get JFrog CLI version: ' + ex);
    }
}

function runCbk(cliPath) {
    console.log('Running jfrog-cli from ' + cliPath + '.');
    logCliVersion(cliPath);
    runTaskCbk(cliPath);
}

function createCliDirs() {
    if (!fs.existsSync(jfrogFolderPath)) {
        fs.mkdirSync(jfrogFolderPath);
    }
}

// Url and AuthHandlers are optional. Using jfrogCliBintrayDownloadUrl by default.
function downloadCli(cliDownloadUrl, cliAuthHandlers) {
    // If unspecified, use the default cliDownloadUrl of Bintray.
    if (!cliDownloadUrl) {
        cliDownloadUrl = jfrogCliBintrayDownloadUrl;
        cliAuthHandlers = [];
    }
    return new Promise((resolve, reject) => {
        localTools
            .downloadTool(cliDownloadUrl, null, cliAuthHandlers)
            .then(downloadPath => {
                toolLib.cacheFile(downloadPath, fileName, toolName, jfrogCliVersion).then(cliDir => {
                    let cliPath = path.join(cliDir, fileName);
                    if (!isWindows()) {
                        fs.chmodSync(cliPath, 0o555);
                    }
                    tl.debug('Finished downloading JFrog cli.');
                    resolve(cliPath);
                });
            })
            .catch(err => {
                reject(err);
            });
    });
}

function getArchitecture() {
    let platform = process.platform;
    if (platform.startsWith('win')) {
        return 'windows-amd64';
    }
    if (platform.includes('darwin')) {
        return 'mac-386';
    }
    if (process.arch.includes('64')) {
        return 'linux-amd64';
    }
    return 'linux-386';
}

function getCliExecutableName() {
    let executable = 'jfrog';
    if (isWindows()) {
        executable += '.exe';
    }
    return executable;
}

/**
 * Escape single backslashes in a string.
 * / -> //
 * // -> //
 * @param string (String) - The string to escape
 * @returns (String) - The string after escaping
 */
function fixWindowsPaths(string) {
    return isWindows() ? string.replace(/([^\\])\\(?!\\)/g, '$1\\\\') : string;
}

function validateSpecWithoutRegex(fileSpec) {
    if (!isWindows()) {
        return;
    }
    let files = JSON.parse(fileSpec)['files'];
    for (const file of Object.keys(files)) {
        let values = files[file];
        let regexp = values['regexp'];
        if (regexp && regexp.toLowerCase() === 'true') {
            throw "The File Spec includes 'regexp: true' which is currently not supported.";
        }
    }
}

/**
 * Encodes spaces with quotes in a path.
 * a/b/Program Files/c --> a/b/"Program Files"/c
 * @param str (String) - The path to encoded.
 * @returns {string} - The encoded path.
 */
function encodePath(str) {
    let encodedPath = '';
    let arr = str.split(path.sep);
    let count = 0;
    for (let section of arr) {
        if (section.length === 0) {
            continue;
        }
        count++;
        if (section.indexOf(' ') > 0 && !section.startsWith('"') && !section.endsWith('"')) {
            section = quote(section);
        }
        encodedPath += section + path.sep;
    }
    if (count > 0 && !str.endsWith(path.sep)) {
        encodedPath = encodedPath.substring(0, encodedPath.length - 1);
    }
    if (str.startsWith(path.sep)) {
        encodedPath = path.sep + encodedPath;
    }

    return encodedPath;
}

/**
 * Runs collect environment variables JFrog CLI command if includeEnvVars is configured to true.
 * @param cliPath - (String) - The cli path.
 */
function collectEnvVarsIfNeeded(cliPath) {
    let includeEnvVars = tl.getBoolInput('includeEnvVars');
    if (includeEnvVars) {
        try {
            collectEnvVars(cliPath);
        } catch (ex) {
            tl.setResult(tl.TaskResult.Failed, ex);
        }
    }
}

/**
 * Runs collect environment variables JFrog CLI command.
 * @param cliPath - (String) - The cli path.
 * @returns (String|void) - String with error message or void if passes successfully.
 * @throws In CLI execution failure.
 */
function collectEnvVars(cliPath) {
    console.log('Collecting environment variables...');
    let buildName = tl.getInput('buildName', true);
    let buildNumber = tl.getInput('buildNumber', true);
    let workDir = tl.getVariable('System.DefaultWorkingDirectory');
    let cliEnvVarsCommand = cliJoin(cliPath, 'rt bce', quote(buildName), quote(buildNumber));
    executeCliCommand(cliEnvVarsCommand, workDir);
}

function isWindows() {
    return process.platform.startsWith('win');
}

function isToolExists(toolName) {
    return !!tl.which(toolName, false);
}

function stripTrailingSlash(str) {
    return str.endsWith('/') ? str.slice(0, -1) : str;
}

/**
 * Determines the required working directory for running the cli.
 * Decision is based on the default path to run, and the provided path by the user.
 */
function determineCliWorkDir(defaultPath, providedPath) {
    if (providedPath) {
        if (path.isAbsolute(providedPath)) {
            return providedPath;
        }
        return path.join(defaultPath, providedPath);
    }
    return defaultPath;
}

/**
 * Creates a build tool config file at a desired absolute path.
 * Resolver / Deployer object should consist serverID and repos according to the build tool used. For example, for maven:
 * {snapshotRepo: 'jcenter', releaseRepo: 'jcenter', serverID: 'local'}
 */
function createBuildToolConfigFile(configPath, buildToolType, resolverObj, deployerObj) {
    let yamlDocument = {};
    yamlDocument.version = buildToolsConfigVersion;
    yamlDocument.type = buildToolType;
    if (resolverObj && Object.keys(resolverObj).length > 0) {
        yamlDocument.resolver = resolverObj;
    }
    if (deployerObj && Object.keys(deployerObj).length > 0) {
        yamlDocument.deployer = deployerObj;
    }
    let configInfo = yaml.safeDump(yamlDocument);
    console.log(configInfo);
    fs.outputFileSync(configPath, configInfo);
}

function assembleBuildToolServerId(buildToolType, serverType) {
    let buildName = tl.getVariable('Build.DefinitionName');
    let buildNumber = tl.getVariable('Build.BuildNumber');
    return [buildName, buildNumber, buildToolType, serverType].join('-');
}

/**
 * Appends build name and number to provided cli command if collectBuildInfo is selected.
 * */
function appendBuildFlagsToCliCommand(cliCommand) {
    if (tl.getBoolInput('collectBuildInfo')) {
        // Construct the build-info collection flags.
        let buildName = tl.getInput('buildName', true);
        let buildNumber = tl.getInput('buildNumber', true);
        return cliJoin(cliCommand, '--build-name=' + quote(buildName), '--build-number=' + quote(buildNumber));
    }
    return cliCommand;
}
