// Prints progress like a batch script does, plus the env the runner set.
console.log(`job ${process.env.RIGPOOL_JOB_ID} url ${process.env.OLLAMA_URL} model ${process.env.OLLAMA_MODEL || '-'}`);
process.stdout.write('1/3\r');
process.stdout.write('2/3\r');
console.log('3/3 done');
