import subprocess, sys
binary = "/tmp/flows-pr-cleanup/pr499/kernel/target/debug/deps/parallel_driver-7a554ae88aa529f9"
for attempt in range(1, 201):
    result = subprocess.run([binary, "pause_before_second_independent_step_holds_the_driver_boundary", "--exact", "--nocapture"], capture_output=True, text=True)
    if result.returncode:
        print(f"Failure on repetition {attempt}:")
        print(result.stdout, result.stderr)
        sys.exit(result.returncode)
print("200 repetitions passed")
