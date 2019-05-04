const inquirer = require('inquirer');
const axios = require('axios');
const _ = require('lodash');
const Bluebird = require('bluebird');
const program = require('commander');
const moment = require('moment');
const fs = require('fs');
const Json2csvParser = require('json2csv').Parser;
const querystring = require('querystring');
const os = require('os');
const path = require('path');

/**
 * TODO: Finish Google's authentication logic.
 * TODO: Use either environment variables or option arguments.
 * TODO: Provide the option to define defaults for the project, committer, etc. and skip steps if those values could be found in the arrays.
 * TODO: Add options to fetch the available branches and let you pick them within the interactive mode.
 */

program
    .version('0.0.1')
    .option('-s, --from [value]', 'Date from...')
    .option('-u --to [value]', 'Date to...')
    .option('-g --group [value]', 'GitLab group name.')
    .option('-f, --filename [value]', 'Filename where the commits will end up.')
    .option('-e, --export [value]', 'Export method of your choice can be either file or google-sheet (WIP).')
    .option('-gt, --gitlab-token [value]', 'Your GitLab private token.')
    .option('-gau, --gitlab-api-url [value]', 'Your GitLab API url.')
    .option('-sgs, --skip-group-selection', 'Skip the entire selection of groups.')
    .option('-smc, --skip-merged-commits', 'Skip merged commits.')
    .option('-p, --project [value]', 'Name of the project/repo.')
    .option('-b, --branch [value]', 'Name of the branch. (default is master).')
    .option('-e, --email [value]', 'Email of the user that pushed the commit.')
    .option('-gsa, --google-service-account [value]', 'Google service account file.')
    .parse(process.argv);

if(!program.gitlabToken) {
    console.error('GitLab private token is missing.');
    return process.exit(1);
}

if(!program.gitlabApiUrl) {
    console.error('GitLab API url is missing.');
    return process.exit(1);
}

// Define axios defaults.
axios.defaults.baseURL = program.gitlabApiUrl;
axios.defaults.headers.get['PRIVATE-TOKEN'] = program.gitlabToken;

//
const branch = 'master';

// Define the project object.
const mapCommit = async (responseData) => {
    return responseData.map(commit => {
        return {
            message: commit.title,
            committer_email: commit.committer_email,
            committed_date: moment(commit.committed_date).format('YYYY-MM-DD'),
        }
    })
};

// Define the group object.
const mapGroup = async (responseData) => {
    return responseData.map(group => {
        return {
            id: group.id,
            name: group.name,
            path: group.path,
        }
    })
};

// Define the project object.
const mapProject = async (responseData) => {
    return responseData.map(repo => {
        return {
            id: repo.id,
            name_with_namespace: repo['name_with_namespace'],
            name: repo['name'],
        }
    })
};

// Prompt the user selection.
const promptUserSelection = async (userEmails) => {
    const { userEmail } = await inquirer.prompt([
        {
            type: "checkbox",
            name: "userEmail",
            message: "Select the user you want to export the commits from.",
            choices: userEmails,
            pageSize: 25,
            validate: (result) => {
                if (result.length === 0) {
                    return 'Error: You must select at least one user.';
                }
                return true;
            },
        },
    ]);
    return userEmail;
};

const promptProjectSelection = async (projectListKeysOnly) => {
    // Prompt the project selection.
    const { projects } = await inquirer.prompt([
        {
            type: 'checkbox',
            name: 'projects',
            message: 'Pick one or multiple projects!',
            choices: projectListKeysOnly,
            pageSize: 25,
            validate: (result) => {
                if (result.length === 0) {
                    return 'Error: You must select at least one project.';
                }
                return true;
            },
        },
    ]);
    return projects;
};

const promptGroupSelection = async (groupListKeysOnly) => {
    // Prompt the group selection.
    const { groups } = await inquirer.prompt([
        {
            type: 'checkbox',
            name: 'groups',
            message: 'Pick one or multiple groups!',
            choices: groupListKeysOnly,
            pageSize: 25,
            validate: (result) => {
                if (result.length === 0) {
                    return 'Error: You must select at least one group.';
                }
                return true;
            },
        },
    ]);
    return groups;
};

// Prompt entering a file name.
const enterFilename = async () => {
    console.log('enterFilename');
    const { filename } = await inquirer.prompt([
        {
            type: 'input',
            name: 'filename',
            message: 'What should the file be called?',
            validate: (result) => {
                if (!result.length) {
                    return 'Error: The file name is too short.';
                }
                return true;
            },
        },
    ]);
    return `${filename}.csv`;
};

// Prompt export method selection.
const promptExportMethodSelection = async () => {
    const { exportMethod } = await inquirer.prompt([
        {
            type: 'list',
            name: 'exportMethod',
            message: 'How do you want to export the commits?',
            choices: ['file (.csv)', 'google sheet'],
            validate: (result) => {
                if (result.length === 0) {
                    return 'Error: You must select at least one export target.';
                }
                return true;
            },
        },
    ]);
    return exportMethod;
};

const apiQueryBuilder = (endpoint, queryOptions, page) => {

    let query = {
        sort: 'asc',
        per_page: 100,
    };

    if(queryOptions !== null) {
        query = _.merge(query, {
            visibility: 'internal',
            archived: false,
            order_by: 'last_activity_at',
            all: true,
            simple: true,
        });
    }

    if(Object.prototype.toString.call(queryOptions) === '[object Array]') {
        if(queryOptions.includes('to') && program && program.to) {
            query.to = `${program.to}T23:59:59Z`;
        }

        if(queryOptions.includes('from') && program && program.from) {
            query.from = `${program.from}T00:00:00Z`;
        }

        if(queryOptions.includes('branch')) {
            query.ref_name = program.branch || branch;
        }

        if(queryOptions.includes('project')
            && program.project) {
            if(program.project.includes('*')) {
                query.search = program.project.replace('*', '');
            } else {
                query.search = program.project;
            }
        }
    } else if(Object.prototype.toString.call(queryOptions) === '[object Object]') {
        if(queryOptions.hasOwnProperty('project')
            && !program.project) {
            try {
                delete queryOptions.project;
            } catch(err) {}
        }
        query = _.merge(query, queryOptions);
    }

    if(typeof page !== 'undefined') {
        query.page = page;
    }

    const queryString = querystring.stringify(query);

    return {
        apiUrl: endpoint + '?' + queryString,
        query: query,
    };
};

const getProjects = async (page) => {
    if(typeof page !== 'number') {
        return page;
    }
    const { apiUrl } = apiQueryBuilder('/projects', ['project'], page);
    return await axios.get(apiUrl)
        .then((response) => mapProject(response.data))
        .catch((error) => {
            throw Error(error);
        });
};

const getGroups = async (page) => {
    if(typeof page !== 'number') {
        return page;
    }
    const { apiUrl } = apiQueryBuilder('/groups', null, page);
    return await axios.get(apiUrl)
        .then((response) => mapProject(response.data))
        .catch((error) => {
            throw Error(error);
        });
};

const getCommits = async (projectId, page) => {
    if(typeof page !== 'number') {
        return page;
    }
    const { apiUrl } = apiQueryBuilder(`/projects/${projectId}/repository/commits`, ['until', 'since', 'branch'], page);
    return await axios.get(apiUrl)
        .then((response) => mapCommit(response.data))
        .catch((error) => {
            throw Error(error);
        });
};

const getAllProjects = async () => {
    const { apiUrl } = apiQueryBuilder('/projects', ['project']);
    return await axios.get(apiUrl)
        .then(async (response) => {
            const totalPageCount = response.headers['x-total-pages'];
            const data = response.data;
            if(!data.length) {
                return [];
            }
            if(totalPageCount === 1) {
                return mapProject(data);
            }
            let pagePromises = [Bluebird.resolve(mapProject(data))];
            for (let i = 2; i <= totalPageCount; i++) {
                pagePromises.push(getProjects(i));
            }
            return await Bluebird.map(pagePromises, async (pageContent) => {
                // ...
                return pageContent;
            })
            .then(content => {
                // Concatenate the array of arrays.
                return [].concat.apply([], content);
            });
        })
        .catch((error) => {
            throw Error(error);
        });
};

const getAllProjectsByGroupId = async (groupId) => {
    const { apiUrl } = apiQueryBuilder(`/groups/${groupId}/projects`, null);
    return await axios.get(apiUrl)
        .then(async (response) => {
            const totalPageCount = response.headers['x-total-pages'];
            const data = response.data;
            if(!data.length) {
                return [];
            }
            if(totalPageCount === 1) {
                return mapProject(data);
            }
            let pagePromises = [Bluebird.resolve(mapProject(data))];
            for (let i = 2; i <= totalPageCount; i++) {
                pagePromises.push(getProjects(i));
            }
            return await Bluebird.map(pagePromises, async (pageContent) => {
                // ...
                return pageContent;
            })
            .then(content => {
                // Concatenate the array of arrays.
                return [].concat.apply([], content);
            });
        })
        .catch((error) => {
            throw Error(error);
        });
};

const getAllGroupedProjects = async (groupsArray) => {
    return await Bluebird.map(groupsArray, async (group) => {
        return await getAllProjectsByGroupId(group.id);
    })
    .then(content => {
        // Concatenate the array of arrays.
        return [].concat.apply([], content);
    });
};

const getAllGroups = async () => {
    const { apiUrl } = apiQueryBuilder('/groups', null);
    return await axios.get(apiUrl)
        .then(async (response) => {
            const totalPageCount = response.headers['x-total-pages'];
            const data = response.data;
            if(!data.length) {
                return [];
            }
            if(totalPageCount === 1) {
                return mapProject(data);
            }
            let pagePromises = [Bluebird.resolve(mapGroup(data))];
            for (let i = 2; i <= totalPageCount; i++) {
                pagePromises.push(getGroups(i));
            }
            return await Bluebird.map(pagePromises, async (pageContent) => {
                // ...
                return pageContent;
            })
            .then(content => {
                // Concatenate the array of arrays.
                return [].concat.apply([], content);
            });
        })
        .catch((error) => {
            throw Error(error);
        });
};

const processGoogleSheetExport = async (reOrderedList) => {
    console.warn(`The google-sheet feature is WIP!`);
    return process.exit(1);
};

const processFileExport = async (filename, reOrderedList) => {
    const filenamePath = path.normalize(__dirname + '/' + filename);

    const fields = ['date', 'messages'];
    const parser = new Json2csvParser({ fields });

    try {
        fs.unlinkSync(filenamePath);
    } catch(err) {
    }

    _.map(reOrderedList, (commits) => {
        try {
            const csv = parser.parse(commits);
            fs.writeFileSync(filenamePath, csv, {
                flag: 'a',
            });
        } catch (err) {
            console.error(err);
        }
    });

    return filenamePath;
};

const getAllCommits = async (projectId) => {
    const { apiUrl } = apiQueryBuilder(`/projects/${projectId}/repository/commits`, ['since', 'until', 'branch']);
    return await axios
        .get(apiUrl)
        .then(async (response) => {
            const totalPageCount = response.headers['x-total-pages'];
            const data = response.data;
            if(totalPageCount === 0) {
                throw Error('No projects found');
            }
            if(totalPageCount === 1) {
                return mapCommit(data);
            }
            let pagePromises = [Bluebird.resolve(mapCommit(data))];
            for (let i = 2; i <= totalPageCount; i++) {
                pagePromises.push(getCommits(projectId, i));
            }
            return await Bluebird.map(pagePromises, async (pageContent) => {
                // ...
                return pageContent;
            })
            .then(commits => {
                let allCommits = [].concat.apply([], commits);
                if(program.skipMergedCommits) {
                    allCommits = allCommits.filter(commit => !commit.message.toLowerCase().includes('merge branch'));
                }
                return allCommits;
            });
        })
        .catch((error) => {
            throw Error(error);
        });
};

const processExportMethods = async (reOrderedList) => {

    let exportMethod = 'file';

    // let exportFilename = Math.floor(Date.now()/1000) + '.csv';
    let exportFilename = null;

    if(program && program.export && ['file', 'google-sheet'].includes(program.export)) {
        if(program.googleServiceAccount && program.export === 'google-sheet') {
            exportMethod = 'google-sheet';
        } else {
            exportMethod = 'file';
        }
    } else {
        exportMethod = await promptExportMethodSelection();
        if(exportMethod.includes('.csv')) {
            exportMethod = 'file';
        }
    }

    if(program.filename) {
        exportFilename = program.filename + '.csv';
    }

    if(exportMethod === 'file') {
        if(!exportFilename) {
            exportFilename = await enterFilename();
        }
        try {
            const filenamePath = await processFileExport(exportFilename, reOrderedList);
            console.log('Export done:', filenamePath);
        } catch(err) {
            throw Error(err);
        }
    } else if(exportMethod === 'google-sheet') {
        try {
            console.log('export to google sheet');
            await processGoogleSheetExport(reOrderedList);
        } catch(err) {
            throw Error(err);
        }
    }
};

(async() => {
    // Define default values...
    let projectList = null;
    let groupList = null;
    let projectListKeysOnly = null;
    let groupListKeysOnly = null;
    let theChosenGroups = null;
    let theChosenOnes = null;
    let allCommits = null;
    let userSelection = null;

    if(!program.skipGroupSelection) {
        // Fetch groups ...
        try {
            // Fetch all projects recursively where the user has access to.
            groupList = await getAllGroups();
            if(!groupList.length) {
                console.error('No groups found.');
                return process.exit(1);
            }
            // Let's grab the project/repo names..
            groupListKeysOnly = groupList.map(p => p.path );
        } catch(err) {
            console.error(err);
            return process.exit(1);
        }

        if(program && program.group && groupListKeysOnly.includes(program.group)) {
            theChosenGroups = [program && program.group];
        } else {
            try {
                // Init prompt with a full list of projects/repos.
                theChosenGroups = await promptGroupSelection(groupListKeysOnly.sort());
            } catch(err) {
                console.error(err);
                return process.exit(1);
            }
        }

        let exportGroups = [];
        _.map(groupList, group => {
            // Build and map an array with the required project information.
            if(theChosenGroups.includes(group.path)) {
                // We only need the ID, name, and name_with_namespace.
                exportGroups.push(_.pick(group, ['id', 'name', 'path']));
            }
        });

        try {
            // Fetch all projects recursively where the user has access to.
            projectList = await getAllGroupedProjects(exportGroups);
            if(!projectList.length) {
                console.error('No projects found.');
                return process.exit(1);
            }
            // Let's grab the group names..
            theChosenOnes = projectList.map(p => p.name );
            // projectListKeysOnly = projectList.map(p => p.name );
        } catch(err) {
            console.error(err);
            return process.exit(1);
        }
    } else {
        try {
            // Fetch all projects recursively where the user has access to.
            projectList = await getAllProjects();
            if(!projectList.length) {
                console.error('No projects found.');
                return process.exit(1);
            }
            // Let's grab the group names..
            projectListKeysOnly = projectList.map(p => p.name );
        } catch(err) {
            console.error(err);
            return process.exit(1);
        }

        if(program && program.project && projectListKeysOnly.includes(program.project)) {
            // Proceed if the given project could be found within the list of available projects/repos.
            theChosenOnes = [program && program.project]
        } else {
            try {
                // Init prompt with a full list of projects/repos.
                theChosenOnes = await promptProjectSelection(projectListKeysOnly.sort());
            } catch(err) {
                console.error(err);
                return process.exit(1);
            }
        }
    }

    let exportArray = [];
    _.map(projectList, project => {
        // Build and map an array with the required project information.
        if(theChosenOnes.includes(project.name)) {
            // We only need the ID, name, and name_with_namespace.
            exportArray.push(_.pick(project, ['id', 'name', 'name_with_namespace']));
        }
    });

    try {
        // Fetch the commits recursively of all given projects.
        allCommits
            = await Bluebird
                .map(exportArray, async (project) => getAllCommits(project.id))
                .then(content => {
                    // Concatenate the array of arrays.
                    return [].concat.apply([], content);
                });
    } catch(err) {
        console.error(err);
        return process.exit(1);
    }

    // Filter and distinct committer emails.
    const committerEmails = [...new Set(allCommits.map(x => x.committer_email))];

    if(!!program.email && committerEmails.includes(program.email)) {
        userSelection = [program.email];
    } else {
        try {
            // Init prompt with a list of users.
            userSelection = await promptUserSelection(committerEmails.sort());
        } catch(err) {
            console.error(err);
            return process.exit(1);
        }
    }

    // Filter commits by user email.
    const filteredCommits = allCommits.filter(commit => userSelection.includes(commit.committer_email));

    // GroupProject/Repo not found. commits by committed date.
    let groupedCommitsByDate = _.groupBy(filteredCommits, 'committed_date');

    // TODO: Do it better next time...
    // Create a new array of objects and postfix commit messages they don't start with a dash.
    let newList = [];
    _.map(groupedCommitsByDate, (value, key) => {
        newList.push({
            messages: value.map(v => {
                if(!/^-\s{1,}/i.test(v.message)) {
                    return `- ${v.message}`;
                }
                return v.message;
            }).join(os.EOL),
            date: key,
        });
    });

    // Reorder the object by its given keys.
    let reOrderedList = {};
    _(newList).keys().sort().each((key) => {
        reOrderedList[key] = newList[key];
    });

    try {
        // Proceed with the export.
        await processExportMethods(reOrderedList);
    } catch(err) {
        console.error(err);
        return process.exit(1);
    }

    console.log('export done')
})();
