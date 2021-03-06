/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var os = require('os');

var assert = require('assert-plus');
var libmanta = require('libmanta');
var once = require('once');



///--- Globals

var HOSTNAME = os.hostname();



///--- Helpers

function reset(opts, cb) {
    cb = once(cb);

    var _opts = {
        wrasse: undefined
    };

    // The fact that we update the job _start_ timestamp is irrelevant,
    // as this path serves only to allow $self to cleanup a job that was
    // abandonded
    if (opts.job.timeArchiveDone)
        _opts.wrasse = HOSTNAME;

    opts.marlin.jobArchiveStart(opts.jobId, _opts, function (err) {
        if (err) {
            cb(err);
        } else {
            opts.log.debug({job: opts.jobId}, 'takeover: job reset');
            cb();
        }
    });
}



///--- API

function takeoverJobs(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.log, 'options.log');
    assert.object(opts.marlin, 'options.marlin');
    assert.number(opts.takeoverTime, 'options.takeoverTime');
    assert.func(cb, 'callback');

    cb = once(cb);

    opts.log.debug('takeoverJobs: entered');

    var log = opts.log;
    var queue = libmanta.createQueue({
        limit: 10,
        worker: reset
    });

    // This guy finds us all non-done jobs that need to be
    // archived that we might want to take over.
    var res = opts.marlin.jobsList({
        archived: true,
        archivedBefore: opts.lingerTime * 2,
        limit: 10000,
        owner: process.env.WRASSE_JOB_OWNER,
        '!wrasse': HOSTNAME,
        state: 'done'
    });

    var res2 = opts.marlin.jobsList({
        archived: false,
        limit: 1000,
        '!mtime': opts.takeoverTime,
        owner: process.env.WRASSE_JOB_OWNER,
        '!wrasse': HOSTNAME,
        state: 'done'
    });

    queue.once('end', function () {
        log.debug('takeoverJobs: done');
        cb();
    });
    queue.on('error', cb);

    res.on('error', cb);
    res2.on('error', cb);

    function push(r) {
        queue.push({
            job: r.value,
            jobId: r.key,
            log: log,
            marlin: opts.marlin
        });
    }

    res.on('record', push);
    res2.on('record', push);

    var hits = 0;
    function close() {
        if (++hits >= 2)
            queue.close();
    }

    res.once('end', close);
    res2.once('end', close);
}



///--- Exports

module.exports = {
    takeoverJobs: takeoverJobs
};
