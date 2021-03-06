var benchmark = require('../build/benchmark/benchmark.js').Benchmark;
var runner = new benchmark.RequestManager([1024]);
// babar isn't in DefinitelyTyped, I didn't feel like putting it in yet.
var babar = require('babar');
var argv = require('yargs')
    .default('n', 10)
    .count('verbose')
    .alias('v', 'verbose')
    .default('concurrency', 1)
    .alias('c', 'concurrency')
    .default('speed', 1)
    .alias('s', 'speed')
    .default('maxtimeouts', 10)
    .alias('m', 'maxtimeouts')
    .argv;

var should_sleep = true;
var num_tests = argv.n;
var verbosity = argv.verbose;
var concurrency = argv.concurrency
var tail_lat = 1000 / argv.speed;
var max_timeouts = argv.maxtimeouts;
console.log("Configured arguments: num tests: " + num_tests + ", concurrency: " + concurrency + 
            ", max timeouts: " + max_timeouts);

// 500ms window for the histogram, broken into 64 buckets.
runner.configureDefaults(concurrency, 64, tail_lat, verbosity, max_timeouts);
runner.runTests(num_tests, function (results) {
    console.log("-------------------------------------------------------");
    console.log("  BENCHMARK COMPLETE");
    console.log("-------------------------------------------------------");
    console.log("Latency histogram (ms) for a run of " + num_tests + " tests:");
    var titles = ["Successful", "Failed", "Timed Out"];
    for (var sz = 0; sz < results.length; sz++) {
        console.log(">> Request size: " + results[sz].requestSize + " bytes");
        for (var i = 0; i < 3; i++) {
            if (results[sz].raw.values[i].length > 0) {
                console.log(babar(results[sz].histogram[i].getPoints(), {
                    caption: titles[i] + " Request Latency",
                    width: 128
                    }));
                var stats = new benchmark.BasicStats(results[sz].raw.values[i]);
                console.log("  " + stats.summary());
            } else {
                console.log(" No " + titles[i] + " requests.");
            }
        }
    }
   should_sleep = false;
   });

function trySleep() {
   if (should_sleep) {
     setTimeout(trySleep, 500);
   }
};

trySleep();
