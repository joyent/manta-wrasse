/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var fs = require('fs');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var dashdash = require('dashdash');
var http = require('http');
var libmanta = require('libmanta');
var manta = require('manta');
var marlin = require('marlin');
var once = require('once');

var app = require('./lib');



///--- Globals

var LOG = bunyan.createLogger({
    name: 'wrasse',
    level: 'info',
    serializers: libmanta.bunyan.serializers
});

var OPTIONS = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        names: ['verbose', 'v'],
        type: 'arrayOfBool',
        help: 'Verbose output. Use multiple times for more verbose.'
    },
    {
        names: ['file', 'f'],
        type: 'string',
        help: 'File to process',
        helpArg: 'FILE'
    }
];




///--- Helpers

function configure() {
    var cfg;
    var opts;
    var parser = new dashdash.Parser({options: OPTIONS});

    try {
        opts = parser.parse(process.argv);
        assert.object(opts, 'options');
    } catch (e) {
        LOG.fatal(e, 'invalid options');
        process.exit(1);
    }

    if (opts.help) {
        console.log('usage: node main.js [OPTIONS]\n'
                    + 'options:\n'
                    + parser.help().trimRight());
        process.exit(0);
    }

    try {
        var _f = opts.file || __dirname + '/etc/config.json';
        cfg = JSON.parse(fs.readFileSync(_f, 'utf8'));
    } catch (e) {
        LOG.fatal(e, 'unable to parse %s', _f);
        process.exit(1);
    }

    assert.object(cfg.auth, 'config.auth');
    assert.object(cfg.manta, 'config.manta');
    assert.object(cfg.marlin, 'config.marlin');

    if (cfg.logLevel)
        LOG.level(cfg.logLevel);

    if (opts.verbose) {
        opts.verbose.forEach(function () {
            LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
        });
    }

    if (LOG.level() <= bunyan.DEBUG)
        LOG = LOG.child({src: true});

    cfg.auth.log = LOG;
    cfg.manta.log = LOG;
    cfg.marlin.log = LOG;

    cfg.pingPort = cfg.pingPort || 80;

    return (cfg);
}


function run(opts) {
    var ee = new EventEmitter();
    var log = opts.log;
    var wait = opts.pollInterval;

    function find() {
        app.findDoneJobs(opts, function (err, jobs) {
            if (err) {
                log.error(err, 'unable to find jobs');
            } else {
                ee.emit('jobs', jobs);
            }

            setTimeout(find, wait);
        });
    }

    function clean() {
        app.cleanupJobs(opts, function (err) {
            if (err)
                log.error(err, 'cleanupJobs: error encountered');

            setTimeout(clean, wait);
        });
    }

    function takeover() {
        app.takeoverJobs(opts, function (err) {
            if (err)
                log.error(err, 'takeoverJobs: error encountered');

            setTimeout(takeover, wait);
        });
    }

    process.nextTick(find);
    process.nextTick(clean);
    process.nextTick(takeover);

    return (ee);
}



///--- Mainline

(function main() {
    var cfg = configure();

    var mantaClient = manta.createClient({
        log: cfg.manta.log,
        sign: manta.privateKeySigner({
            key: fs.readFileSync(cfg.manta.key, 'utf8'),
            keyId: cfg.manta.keyId,
            user: cfg.manta.user
        }),
        rejectUnauthorized: false,
        user: cfg.manta.user,
        url: cfg.manta.url
    });
    assert.object(mantaClient, 'manta client');

    app.createMahiClient(cfg.auth, function (mahi_err, mahi) {
        assert.ifError(mahi_err);

        var _cfg = cfg.marlin;
        marlin.createClient(_cfg, function (marlin_err, marlinClient) {
            assert.ifError(marlin_err);

            marlinClient.on('error', function (err) {
                LOG.error(err, 'marlin client error');
            });

            var ps = http.createServer(function (req, res) {
                res.end('Ok.');
            });
            ps.listen(cfg.pingPort);

            var opts = {
                deleteLimit: cfg.deleteLimit,
                deleteTimeout: cfg.deleteTimeout,
                lingerTime: cfg.lingerTime || 86400, // 24 hrs
                log: LOG,
                mahi: mahi,
                manta: mantaClient,
                marlin: marlinClient,
                pollInterval: (cfg.pollInterval || 10) * 1000, // 10 seconds
                takeoverTime: cfg.takeoverTime || 1800 // 30 minutes
            };
            var queue = libmanta.createQueue({
                limit: 10,
                worker: app.upload(opts)
            });

            queue.on('error', function (err) {
                LOG.error(err, 'job upload failed');
            });

            queue.once('end', function () {
                mahi.close();
                mantaClient.close();
                marlinClient.close();
                ps.close();
            });

            run(opts).on('jobs', function (jobs) {
                jobs.forEach(queue.push.bind(queue));
            });
        });
    });
})();
