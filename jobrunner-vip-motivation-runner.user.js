// ==UserScript==
// @name         Job Planner - Motivation Runner
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Runs selected jobs for 15 seconds until their motivation reaches the chosen threshold.\n
// @author       Whitesound
// @include      https://*.the-west.*/game.php*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const SETTINGS_STORAGE_KEY = 'job-planner-motivation-settings-v1';

    function getSavedSettings() {
        const defaults = { travelSet: -1, jobSet: -1, delayMin: 1, delayMax: 7, healthStop: 10 };
        try {
            return Object.assign(defaults, JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'));
        } catch (e) {
            return defaults;
        }
    }

    function Job(x, y, id) {
        this.x = x;
        this.y = y;
        this.id = id;
        this.silver = false;
        this.distance = 0;
        this.experience = 0;
        this.money = 0;
        this.motivation = 0;
        this.jobSetIndex = -2; // -2 = use the default job set from Settings, -1 = no set, >=0 = specific set index
    }

    const Planner = {
        window: null,
        loaded: false,
        allJobs: [],
        plannedJobs: [], // jobs the user picked to see a suggested route for
        sortByXp: 0,
        sortByDistance: 0,
        filterText: '',
        running: false,
        stopMotivation: 75,
        currentPlanIndex: 0,
        routeMotivationElements: [],
        motivationRefreshTimer: null,
        sets: null,
        settings: getSavedSettings()
    };

    // ---------- Data loading (read-only: same data the game already shows on the map) ----------

    Planner.loadJobs = function() {
        if (Planner.loaded) {
            Planner.loadSets(function() { Planner.createWindow(); });
            return;
        }

        new UserMessage('Loading jobs...', UserMessage.TYPE_HINT).show();

        const tiles = [];
        const jobs = [];
        let index = 0;
        let currentLength = 0;
        const maxLength = 299;

        Ajax.get('map', 'get_minimap', {}, function(r) {
            for (const jobGroup in r.job_groups) {
                const group = r.job_groups[jobGroup];
                const jobsGroup = JobList.getJobsByGroupId(parseInt(jobGroup));

                for (let t = 0; t < group.length; t++) {
                    const xCoord = Math.floor(group[t][0] / GameMap.tileSize);
                    const yCoord = Math.floor(group[t][1] / GameMap.tileSize);

                    if (currentLength === 0) tiles[index] = [];
                    tiles[index].push([xCoord, yCoord]);
                    currentLength++;
                    if (currentLength === maxLength) {
                        currentLength = 0;
                        index++;
                    }

                    for (let i = 0; i < jobsGroup.length; i++) {
                        jobs.push(new Job(group[t][0], group[t][1], jobsGroup[i].id));
                    }
                }
            }

            const toLoad = tiles.length;
            let loaded = 0;

            for (let b = 0; b < tiles.length; b++) {
                GameMap.Data.Loader.load(tiles[b], function() {
                    loaded++;
                    if (loaded === toLoad) {
                        Ajax.get('work', 'index', {}, function(rw) {
                            if (rw.error) {
                                console.log(rw.error);
                                return;
                            }
                            JobsModel.initJobs(rw.jobs);
                            Planner.allJobs = jobs;
                            Planner.loaded = true;
                            Planner.loadSets(function() { Planner.createWindow(); });
                        });
                    }
                });
            }
        });
    };

    Planner.checkIfSilver = function(x, y, id) {
        const key = x + '-' + y;
        const jobData = GameMap.JobHandler.Featured[key];
        if (jobData == undefined || jobData[id] == undefined) return false;
        return jobData[id].silver;
    };

    Planner.findJobData = function(job) {
        for (let i = 0; i < JobsModel.Jobs.length; i++) {
            if (JobsModel.Jobs[i].id == job.id) return JobsModel.Jobs[i];
        }
    };

    Planner.compareUnique = function(job, jobs) {
        for (let i = 0; i < jobs.length; i++) {
            if (jobs[i].id == job.id) {
                if ((job.silver && !jobs[i].silver) ||
                    (job.silver == jobs[i].silver && job.distance < jobs[i].distance)) {
                    jobs.splice(i, 1);
                    jobs.push(job);
                }
                return;
            }
        }
        jobs.push(job);
    };

    Planner.getUniqueJobs = function() {
        const jobs = [];

        for (let i = 0; i < Planner.allJobs.length; i++) {
            const job = Planner.allJobs[i];

            if (Planner.filterText != '' &&
                !JobList.getJobById(job.id).name.toLowerCase().includes(Planner.filterText)) {
                continue;
            }

            // A job can require the selected job set. Keep it visible here;
            // the runner equips that set before it queues the job.

            job.silver = Planner.checkIfSilver(job.x, job.y, job.id);
            job.distance = GameMap.calcWayTime({ x: job.x, y: job.y }, Character.position);

            Planner.compareUnique(job, jobs);
        }

        for (let i = 0; i < jobs.length; i++) {
            const data = Planner.findJobData(jobs[i]);
            let xp = data.basis.short.experience;
            let money = data.basis.short.money;
            jobs[i].motivation = data.jobmotivation * 100;
            if (jobs[i].silver) {
                xp = Math.ceil(1.5 * xp);
                money = Math.ceil(1.5 * money);
            }
            jobs[i].experience = xp;
            jobs[i].money = money;
        }

        const byXp = (a, b) => (a.experience > b.experience ? -1 : a.experience < b.experience ? 1 : 0);
        const byXpRev = (a, b) => (a.experience > b.experience ? 1 : a.experience < b.experience ? -1 : 0);
        const byDist = (a, b) => (a.distance > b.distance ? -1 : a.distance < b.distance ? 1 : 0);
        const byDistRev = (a, b) => (a.distance > b.distance ? 1 : a.distance < b.distance ? -1 : 0);

        if (Planner.sortByXp == 1) jobs.sort(byXp);
        if (Planner.sortByXp == -1) jobs.sort(byXpRev);
        if (Planner.sortByDistance == 1) jobs.sort(byDist);
        if (Planner.sortByDistance == -1) jobs.sort(byDistRev);

        return jobs;
    };

    // ---------- Suggested route (display only ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â nearest-neighbour ordering of jobs you picked) ----------

    Planner.addToPlan = function(x, y, id) {
        for (let i = 0; i < Planner.plannedJobs.length; i++) {
            if (Planner.plannedJobs[i].x == x && Planner.plannedJobs[i].y == y && Planner.plannedJobs[i].id == id) return;
        }
        for (let i = 0; i < Planner.allJobs.length; i++) {
            const j = Planner.allJobs[i];
            if (j.x == x && j.y == y && j.id == id) {
                Planner.plannedJobs.push(j);
                break;
            }
        }
    };

    Planner.removeFromPlan = function(x, y, id) {
        for (let i = 0; i < Planner.plannedJobs.length; i++) {
            if (Planner.plannedJobs[i].x == x && Planner.plannedJobs[i].y == y && Planner.plannedJobs[i].id == id) {
                Planner.plannedJobs.splice(i, 1);
                break;
            }
        }
    };

    Planner.suggestedRoute = function() {
        if (Planner.plannedJobs.length === 0) return [];

        const points = Planner.plannedJobs.map(j => ({ job: j, x: j.x, y: j.y }));
        const start = Character.position;

        const remaining = points.slice();
        const route = [];
        let current = { x: start.x, y: start.y };

        while (remaining.length > 0) {
            let bestIdx = 0;
            let bestDist = GameMap.calcWayTime(current, remaining[0]);
            for (let i = 1; i < remaining.length; i++) {
                const d = GameMap.calcWayTime(current, remaining[i]);
                if (d < bestDist) {
                    bestDist = d;
                    bestIdx = i;
                }
            }
            const next = remaining.splice(bestIdx, 1)[0];
            route.push(next.job);
            current = { x: next.x, y: next.y };
        }

        return route;
    };

    // ---------- UI ----------

    Planner.getJobIconHtml = function(job) {
        const silverHtml = job.silver ? '<div class="featured silver"></div>' : '';
        return '<div class="job" style="position:relative;"><div class="featured"></div>' +
            silverHtml +
            '<img src="../images/jobs/' + JobList.getJobById(job.id).shortname + '.png" class="job_icon" style="max-width:40px;max-height:40px;display:block;">' +
            '</div>';
    };

    Planner.insertCss = function() {
        $('.jobplanner-window').css({ 'display': 'block', 'width': '100%', 'boxSizing': 'border-box' });
        $('.jobplanner-tablescroll').css({
            'display': 'block',
            'maxHeight': '300px',
            'overflowY': 'auto',
            'overflowX': 'hidden',
            'border': '1px solid #999'
        });
        $('.jobplanner-row').css({
            'background': 'rgba(255, 204, 0, 0.10)',
            'border': '1px solid rgba(255, 204, 0, 0.35)',
            'borderRadius': '4px'
        });
        $('.jobplanner-row').hover(
            function() { $(this).css('background', 'rgba(255, 204, 0, 0.22)'); },
            function() { $(this).css('background', 'rgba(255, 204, 0, 0.10)'); }
        );
    };

    Planner.createWindow = function() {
        const win = wman.open('jobplanner')
            .setResizeable(true)
            .setMinSize(700, 480)
            .setSize(700, 480)
            .setMiniTitle('Job Planner');

        const content = $('<div class="jobplanner-window" style="padding:8px;box-sizing:border-box;"></div>');

        const filterRow = $('<div style="margin-bottom:8px;"></div>');
        const filterInput = $('<input type="text" placeholder="Filter by job name" style="width:200px;">').val(Planner.filterText);
        const filterBtn = $('<button style="margin-left:6px;">Filter</button>');
        const settingsBtn = $('<button style="margin-left:6px;">Settings</button>');
        filterRow.append(filterInput).append(filterBtn).append(settingsBtn);

        const tableScroll = $('<div class="jobplanner-tablescroll"></div>');
        const table = $('<table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;"></table>');
        const xpArrow = Planner.sortByXp == 1 ? ' ^' : Planner.sortByXp == -1 ? ' v' : '';
        const distArrow = Planner.sortByDistance == 1 ? ' ^' : Planner.sortByDistance == -1 ? ' v' : '';

        table.append(
            '<colgroup>' +
            '<col style="width:50px;"><col><col style="width:50px;"><col style="width:60px;">' +
            '<col style="width:70px;"><col style="width:70px;"><col style="width:80px;"><col style="width:130px;">' +
            '</colgroup>'
        );
        table.append(
            '<tr style="text-align:left;border-bottom:1px solid #999;background:#eee;position:sticky;top:0;">' +
            '<th></th><th>Job</th><th class="sort-xp" style="cursor:pointer;">XP' + xpArrow + '</th>' +
            '<th>Money</th><th>Motivation</th>' +
            '<th class="sort-dist" style="cursor:pointer;">Distance' + distArrow + '</th>' +
            '<th></th><th></th></tr>'
        );

        const uniqueJobs = Planner.getUniqueJobs();

        for (let i = 0; i < uniqueJobs.length; i++) {
            const job = uniqueJobs[i];
            const inPlan = Planner.plannedJobs.some(p => p.x == job.x && p.y == job.y && p.id == job.id);

            const row = $('<tr class="jobplanner-row" style="border-bottom:1px solid #ddd;"></tr>');
            row.append('<td>' + Planner.getJobIconHtml(job) + '</td>');
            row.append('<td>' + JobList.getJobById(job.id).name + '</td>');
            row.append('<td>' + job.experience + '</td>');
            row.append('<td>' + job.money + '</td>');
            row.append('<td>' + job.motivation + '%</td>');
            row.append('<td>' + job.distance.formatDuration() + '</td>');

            const openBtn = $('<button>Open job</button>');
            openBtn.on('click', function() {
                // Opens the normal in-game job window, same as clicking the job on the map.
                // Starting the job is still done manually by the user inside that window.
                GameMap.JobHandler.openJob(job.id, { x: job.x, y: job.y });
            });
            row.append($('<td></td>').append(openBtn));

            const planBtn = $('<button style="width:120px;">' + (inPlan ? 'Remove from plan' : 'Add to plan') + '</button>');
            planBtn.on('click', function() {
                if (inPlan) {
                    Planner.removeFromPlan(job.x, job.y, job.id);
                } else {
                    Planner.addToPlan(job.x, job.y, job.id);
                }
                Planner.createWindow();
            });
            row.append($('<td></td>').append(planBtn));

            table.append(row);
        }

        tableScroll.append(table);
        content.append(filterRow).append(tableScroll);

        win.appendToContentPane(content);
        Planner.insertCss();

        content.find('.sort-xp').on('click', function() {
            Planner.sortByXp = Planner.sortByXp == 1 ? -1 : Planner.sortByXp == -1 ? 0 : 1;
            Planner.sortByDistance = 0;
            Planner.createWindow();
        });
        content.find('.sort-dist').on('click', function() {
            Planner.sortByDistance = Planner.sortByDistance == 1 ? -1 : Planner.sortByDistance == -1 ? 0 : 1;
            Planner.sortByXp = 0;
            Planner.createWindow();
        });
        filterBtn.on('click', function() {
            Planner.filterText = filterInput.val().trim().toLowerCase();
            Planner.createWindow();
        });
        settingsBtn.on('click', Planner.openSettingsWindow);

        Planner.window = win;

        Planner.createRouteWindow();
    };

    // ---------- Second window: planned jobs + suggested route (to the right of the main window) ----------

    Planner.loadJobMotivation = function(job, callback) {
        Ajax.get('job', 'job', { jobId: job.id, x: job.x, y: job.y }, function(r) {
            callback(r.motivation * 100);
        });
    };

    Planner.paintMotivation = function(line, card, motivation) {
        const isAtThreshold = motivation <= Planner.stopMotivation;
        line.text('Motivation: ' + Math.round(motivation) + '%');
        line.css({
            'color': isAtThreshold ? '#c0392b' : '#2e7d32',
            'fontWeight': isAtThreshold ? 'bold' : 'normal'
        });
        card.css({
            'border': isAtThreshold ? '1px solid rgba(192, 57, 43, 0.6)' : '',
            'background': isAtThreshold ? 'rgba(192, 57, 43, 0.12)' : ''
        });
    };

    Planner.refreshRouteMotivations = function() {
        Planner.routeMotivationElements.forEach(function(entry) {
            Planner.loadJobMotivation(entry.job, function(motivation) {
                Planner.paintMotivation(entry.line, entry.card, motivation);
            });
        });
    };

    Planner.startMotivationRefresh = function() {
        if (Planner.motivationRefreshTimer !== null) return;
        Planner.motivationRefreshTimer = setInterval(function() {
            Planner.refreshRouteMotivations();
        }, 2500);
    };

    Planner.wait = function(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    };

    Planner.stopRunner = function() {
        Planner.running = false;
        if (TaskQueue.queue.length > 0) TaskQueue.cancelAll();
        Planner.createWindow();
    };

    Planner.findNextRunnableJob = async function() {
        // Keep the plan order: a job is completed to the threshold before the next one starts.
        for (let index = 0; index < Planner.plannedJobs.length; index++) {
            const job = Planner.plannedJobs[index];
            const motivation = await new Promise(function(resolve) {
                Planner.loadJobMotivation(job, resolve);
            });
            if (motivation > Planner.stopMotivation) return job;
        }
        return null;
    };

    Planner.healthPercent = function() {
        return Character.maxHealth ? (Character.health / Character.maxHealth) * 100 : 0;
    };

    Planner.randomDelay = function() {
        const min = Math.max(0, Number(Planner.settings.delayMin) || 0);
        const max = Math.max(min, Number(Planner.settings.delayMax) || min);
        return Math.floor(min + Math.random() * (max - min + 1)) * 1000;
    };

    Planner.loadSets = function(callback) {
        if (Planner.sets !== null) return callback(Planner.sets);
        Ajax.remoteCallMode('inventory', 'show_equip', {}, function(result) {
            Planner.sets = result.data || [];
            callback(Planner.sets);
        });
    };

    Planner.getSetItems = function(set) {
        const items = [];
        ['head', 'neck', 'body', 'right_arm', 'left_arm', 'belt', 'foot', 'animal', 'yield', 'pants']
            .forEach(function(slot) { if (set[slot] != null) items.push(set[slot]); });
        return items;
    };

    Planner.isWearing = function(itemId) {
        const item = ItemManager.get(itemId);
        return item && Wear.wear[item.type] && Wear.wear[item.type].obj && Wear.wear[item.type].obj.item_id === itemId;
    };

    Planner.equipSet = async function(index) {
        if (index === -1) return true;
        if (!Planner.sets) {
            // Sets are normally only fetched when opening the Settings window.
            // Load them here too, so the runner works even if Settings was never opened this session.
            await new Promise(function(resolve) { Planner.loadSets(resolve); });
        }
        if (!Planner.sets || !Planner.sets[index]) return false;
        const set = Planner.sets[index];
        EquipManager.switchEquip(set.equip_manager_id);
        const wantedItems = Planner.getSetItems(set);
        // Wait for the inventory update, then confirm every item of this set.
        await Planner.wait(150);
        for (let tries = 0; tries < 100; tries++) {
            if (wantedItems.every(Planner.isWearing)) return true;
            await Planner.wait(40);
        }
        return false;
    };

    // Resolves which "job set" to use for a specific planned job: its own override
    // (chosen in the planned-jobs list) if set, otherwise the default from Settings.
    Planner.getJobSetForJob = function(job) {
        if (job.jobSetIndex === undefined || job.jobSetIndex === -2) return Planner.settings.jobSet;
        return job.jobSetIndex;
    };

    // Queues the job twice (same as before) and reports whether the queue actually grew,
    // which is how we detect that the game rejected the job with the currently worn set.
Planner.tryQueueJob = async function(job) {
    const queueLengthBefore = TaskQueue.queue.length;

    // Primul startJob
    JobWindow.startJob(job.id, job.x, job.y, 15);
    await Planner.wait(1500);

    if (TaskQueue.queue.length > queueLengthBefore) {
        return true;
    }

    // Al doilea startJob, doar dacă primul nu a intrat
    JobWindow.startJob(job.id, job.x, job.y, 15);
    await Planner.wait(1500);

    if (TaskQueue.queue.length > queueLengthBefore) {
        return true;
    }

    // Retry suplimentar – polling pe coadă
    const maxRetries = 5; // 5 × 500ms = ~2.5s extra
    for (let i = 0; i < maxRetries; i++) {
        await Planner.wait(500);
        if (TaskQueue.queue.length > queueLengthBefore) {
            return true;
        }
    }

    return false;
};

Planner.walkToJob = async function(job) {
    // Try to queue the walk while wearing the TRAVEL set first, so the game computes the
    // correct (fast) travel duration. Equipping the travel set only after queueing with the
    // job set does not retroactively fix the travel time, so order matters here.
    // If the game rejects the job with the travel set on (e.g. it requires job-set clothing),
    // fall back to queueing with the job set instead.
    let queued = false;

    if (Planner.settings.travelSet !== -1) {
        if (!await Planner.equipSet(Planner.settings.travelSet)) {
            Planner.running = false;
            new UserMessage('The selected travel set could not be equipped. Runner stopped.', UserMessage.TYPE_ERROR).show();
            Planner.createWindow();
            return;
        }
        // dăm mai mult timp după equip travel set
        await Planner.wait(2000);
        queued = await Planner.tryQueueJob(job);
    }

    if (!queued) {
        // Fallback: the travel set wasn't valid for this job (or no travel set is configured).
        const jobSetIndex = Planner.getJobSetForJob(job);
        if (jobSetIndex === -1) {
            Planner.running = false;
            new UserMessage('No job set configured for this job - cannot fall back. Runner stopped.', UserMessage.TYPE_ERROR).show();
            Planner.createWindow();
            return;
        }
        if (!await Planner.equipSet(jobSetIndex)) {
            Planner.running = false;
            new UserMessage('Job set could not be equipped (check the per-job set, or reopen Settings and re-save). Runner stopped.', UserMessage.TYPE_ERROR).show();
            Planner.createWindow();
            return;
        }
        // și după equip job set îi mai dăm timp
        await Planner.wait(2000);
        queued = await Planner.tryQueueJob(job);

        if (!queued) {
            Planner.running = false;
            new UserMessage('This job could not be queued with either set. Runner stopped.', UserMessage.TYPE_ERROR).show();
            Planner.createWindow();
            return;
        }
    }

    while (Planner.running) {
        if (GameMap.calcWayTime(Character.position, { x: job.x, y: job.y }) === 0) {
            if (TaskQueue.queue.length > 0) TaskQueue.cancelAll();
            break;
        }
        await Planner.wait(100);
    }
    if (Planner.running) {
        // We've arrived (or cleared the temporary queue) - make sure the job set is worn
        // before actually running the job, regardless of which set got us here.
        await Planner.wait(1000);
        if (!await Planner.equipSet(Planner.getJobSetForJob(job))) {
            Planner.running = false;
            new UserMessage('The selected job set could not be equipped. Runner stopped.', UserMessage.TYPE_ERROR).show();
            Planner.createWindow();
            return;
        }
        await Planner.wait(1000);
        Planner.prepareJobRun();
    }
};

Planner.runJobBatch = async function(job) {
    if (!await Planner.equipSet(Planner.getJobSetForJob(job))) {
        Planner.running = false;
        new UserMessage('The selected job set could not be equipped. Runner stopped.', UserMessage.TYPE_ERROR).show();
        Planner.createWindow();
        return;
    }
    const motivation = await new Promise(function(resolve) {
        Planner.loadJobMotivation(job, resolve);
    });
    const maxQueuedJobs = Premium.hasBonus('automation') ? 9 : 4;
    const jobCount = Math.min(
        Math.floor(motivation - Planner.stopMotivation),
        Character.energy,
        maxQueuedJobs
    );

    if (jobCount < 1) return Planner.prepareJobRun();

    for (let i = 0; i < jobCount; i++) {
        JobWindow.startJob(job.id, job.x, job.y, 15);
    }

    while (Planner.running && TaskQueue.queue.length > 0) {
        await Planner.wait(40);
    }
    if (Planner.running) Planner.prepareJobRun();
};

Planner.prepareJobRun = function() {
    if (!Planner.running) return;

    setTimeout(async function() {
        if (!Planner.running) return;
        if (Character.energy <= 0 || Planner.healthPercent() <= Planner.settings.healthStop) {
            Planner.running = false;
            Planner.createWindow();
            return;
        }

        const job = await Planner.findNextRunnableJob();
        if (job === null) {
            Planner.running = false;
            Planner.createWindow();
            return;
        }

        if (GameMap.calcWayTime(Character.position, { x: job.x, y: job.y }) === 0) {
            Planner.runJobBatch(job);
        } else {
            Planner.walkToJob(job);
        }
    }, Planner.randomDelay());
};

Planner.runSelectedJobs = async function() {
    if (Planner.running || Planner.plannedJobs.length === 0) return;

    // Confirm the job set before any motivation check, queue operation or travel.
    const firstJobSet = Planner.getJobSetForJob(Planner.plannedJobs[0]);
    if (!await Planner.equipSet(firstJobSet)) {
        new UserMessage('Choose a valid job set (in Settings, or per-job in the list) before starting.', UserMessage.TYPE_ERROR).show();
        return;
    }

    Planner.running = true;
    Planner.createWindow();
    Planner.prepareJobRun();
};

    Planner.createRouteWindow = function() {
        const win = wman.open('jobplanner-route')
            .setResizeable(true)
            .setMinSize(280, 480)
            .setSize(280, 480)
            .setMiniTitle('Planned Jobs');

        const content = $('<div class="jobplanner-routewindow" style="padding:8px;box-sizing:border-box;"></div>');
        content.append('<b>Planned jobs (' + Planner.plannedJobs.length + ')</b>');
        content.append('<div style="color:#888;font-size:11px;margin-bottom:8px;">Suggested visiting order, based on shortest travel distance. You still walk there and start each job yourself.</div>');

        const runnerControls = $('<div style="margin:8px 0;"></div>');
        const thresholdInput = $('<input type="number" min="0" max="100" style="width:55px;">').val(Planner.stopMotivation);
        const startButton = $('<button style="margin-left:6px;">Start</button>');
        const stopButton = $('<button style="margin-left:6px;">Stop</button>');
        runnerControls.append('Stop at: ').append(thresholdInput).append('% ')
            .append(startButton).append(stopButton)
            .append('<div style="margin-top:4px;color:#888;font-size:11px;">Status: ' + (Planner.running ? 'running' : 'idle') + '. Jobs run for 15 seconds.</div>');
        content.append(runnerControls);

        thresholdInput.on('change', function() {
            Planner.stopMotivation = Math.max(0, Math.min(100, parseInt(thresholdInput.val(), 10) || 75));
            thresholdInput.val(Planner.stopMotivation);
        });
        startButton.on('click', Planner.runSelectedJobs);
        stopButton.on('click', Planner.stopRunner);

        const listBox = $('<div class="jobplanner-routelist"></div>');
        const route = Planner.suggestedRoute();
        Planner.routeMotivationElements = [];

        if (route.length === 0) {
            listBox.append('<div style="color:#888;">No jobs added yet. Use "Add to plan" in the Job Planner window.</div>');
        } else {
            const ol = $('<ol style="padding-left:18px;margin:0;"></ol>');
            for (let i = 0; i < route.length; i++) {
                const job = route[i];
                const li = $('<li class="jobplanner-row" style="margin-bottom:6px;padding:4px;"></li>');

                const nameLink = $('<div style="cursor:pointer;text-decoration:underline;">' +
                    JobList.getJobById(job.id).name + '</div>');
                nameLink.on('click', function() {
                    // Opens the normal in-game job window, same as clicking the job on the map.
                    // Starting the job is still done manually by the user inside that window.
                    GameMap.JobHandler.openJob(job.id, { x: job.x, y: job.y });
                });
                li.append(nameLink);

                li.append('<div style="font-size:11px;color:#888;">x:' + job.x + ' y:' + job.y + '</div>');

                const motivationLine = $('<div class="jobplanner-motivation" style="font-size:11px;">Motivation: loading...</div>');
                li.append(motivationLine);
                Planner.routeMotivationElements.push({ job: job, line: motivationLine, card: li });
                Planner.loadJobMotivation(job, function(motivation) {
                    Planner.paintMotivation(motivationLine, li, motivation);
                });

                const jobSetRow = $('<div style="margin-top:4px;font-size:11px;"></div>');
                jobSetRow.append('Set job: ');
                const jobSetSelect = $('<select style="max-width:150px;font-size:11px;"></select>');
                jobSetSelect.append('<option value="-2">by default (Settings)</option>');
                jobSetSelect.append('<option value="-1">No set</option>');
                (Planner.sets || []).forEach(function(set, idx) {
                    jobSetSelect.append($('<option></option>').val(idx).text(set.name));
                });
                jobSetSelect.val(job.jobSetIndex !== undefined ? job.jobSetIndex : -2);
                jobSetSelect.on('change', function() {
                    job.jobSetIndex = parseInt(jobSetSelect.val(), 10);
                });
                jobSetRow.append(jobSetSelect);
                li.append(jobSetRow);

                const removeBtn = $('<button style="margin-top:4px;">Remove</button>');
                removeBtn.on('click', function() {
                    Planner.removeFromPlan(job.x, job.y, job.id);
                    Planner.createWindow();
                });
                li.append(removeBtn);
                ol.append(li);
            }
            listBox.append(ol);
        }

        content.append(listBox);
        win.appendToContentPane(content);

        $('.jobplanner-routewindow').css({ 'display': 'block', 'width': '100%', 'boxSizing': 'border-box' });
        $('.jobplanner-routelist').css({
            'display': 'block',
            'maxHeight': '360px',
            'overflowY': 'auto',
            'overflowX': 'hidden'
        });

        // Position it to the right of the main job list window
        if (Planner.window && Planner.window.divMain) {
            const mainWindowElement = $(Planner.window.divMain);
            const mainPos = mainWindowElement.position();
            const mainWidth = mainWindowElement.outerWidth();
            if (mainPos) {
                $(win.divMain).css({
                    left: (mainPos.left + mainWidth + 10) + 'px',
                    top: mainPos.top + 'px'
                });
            }
        }

        Planner.routeWindow = win;
        Planner.startMotivationRefresh();
    };

    Planner.openSettingsWindow = function() {
        Planner.loadSets(function(sets) {
            const win = wman.open('jobplanner-settings')
                .setResizeable(false)
                .setMinSize(330, 285)
                .setSize(330, 285)
                .setMiniTitle('Job Planner Settings');

            const content = $('<div style="padding:12px;box-sizing:border-box;"></div>');
            const travel = $('<select style="width:180px;"></select>');
            const job = $('<select style="width:180px;"></select>');
            travel.append('<option value="-1">No travel set</option>');
            job.append('<option value="-1">No job set</option>');
            sets.forEach(function(set, index) {
                travel.append($('<option></option>').val(index).text(set.name));
                job.append($('<option></option>').val(index).text(set.name));
            });
            travel.val(Planner.settings.travelSet);
            job.val(Planner.settings.jobSet);

            const delayMin = $('<input type="number" min="0" max="60" style="width:48px;">').val(Planner.settings.delayMin);
            const delayMax = $('<input type="number" min="0" max="60" style="width:48px;">').val(Planner.settings.delayMax);
            const healthStop = $('<input type="number" min="1" max="100" style="width:48px;">').val(Planner.settings.healthStop);
            const save = $('<button style="margin-top:12px;">Save settings</button>');

            content.append('<div style="margin-bottom:9px;"><b>Travel set</b><br></div>').append(travel);
            content.append('<div style="margin:12px 0 9px;"><b>Job set</b><br></div>').append(job);
            content.append('<div style="margin-top:12px;"><b>Delay between batches:</b> ').append(delayMin).append(' - ').append(delayMax).append(' seconds</div>');
            content.append('<div style="margin-top:12px;"><b>Stop farming at health:</b> ').append(healthStop).append('%</div>');
            content.append(save);

            save.on('click', function() {
                Planner.settings.travelSet = parseInt(travel.val(), 10);
                Planner.settings.jobSet = parseInt(job.val(), 10);
                Planner.settings.delayMin = Math.max(0, parseInt(delayMin.val(), 10) || 1);
                Planner.settings.delayMax = Math.max(Planner.settings.delayMin, parseInt(delayMax.val(), 10) || 7);
                Planner.settings.healthStop = Math.max(1, Math.min(100, parseInt(healthStop.val(), 10) || 10));
                localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(Planner.settings));
                Planner.createWindow();
            });

            win.appendToContentPane(content);
        });
    };

    // ---------- Menu icon ----------

    Planner.createMenuIcon = function() {
        const div = $('<div class="ui_menucontainer" />');
        const link = $('<div class="menulink" title="Job Planner">JP</div>').css({
            'text-align': 'center',
            'line-height': '25px',
            'font-weight': 'bold',
            'font-size': '11px'
        });
        link.on('click', function() {
            Planner.loadJobs();
        });
        $('#ui_menubar').append(div.append(link).append('<div class="menucontainer_bottom" />'));
    };

    $(document).ready(function() {
        try {
            Planner.createMenuIcon();
        } catch (e) {
            console.log(e.stack);
        }
    });

})();
