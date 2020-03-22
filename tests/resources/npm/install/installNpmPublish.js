const testUtils = require('../../../testUtils');

let inputs = {
    buildName: 'npmInstallTest',
    buildNumber: '1',
    collectBuildInfo: true,
    workingFolder: 'npm',
    command: 'pack and publish',
    targetRepo: testUtils.getRepoKeys().npmLocalRepo,
    arguments: ''
};

testUtils.runTask(testUtils.npm, {}, inputs);
