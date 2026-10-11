use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use relayflowd::{CancelOptions, DriveOptions, Engine, RunStatus, engine::read_spec, server};

#[derive(Debug, Parser)]
#[command(
    name = "relayflowd",
    version,
    about = "Relayflow durable execution kernel"
)]
struct Cli {
    #[arg(long, global = true, default_value = ".relayflowd")]
    data_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate a kernel spec from stdin without creating a run or journal.
    ValidateSpec,
    /// Start and execute a run spec JSON file.
    Run {
        spec: PathBuf,
        /// Submit an event to the flow's subscriptions instead of starting directly.
        #[arg(long)]
        event: Option<String>,
        #[arg(long, default_value = "cli")]
        created_by: String,
        /// Test/debug boundary: return after this many newly completed steps.
        #[arg(long, hide = true)]
        stop_after: Option<usize>,
        /// Test/debug boundary: pause before the named runnable step.
        #[arg(long, hide = true)]
        pause_before_step: Option<String>,
        /// Test/debug boundary: pause after all steps, before run completion.
        #[arg(long, hide = true)]
        pause_before_completion: bool,
    },
    /// Resume a run from its durable journal.
    Resume {
        run_id: String,
        #[arg(long, hide = true)]
        stop_after: Option<usize>,
    },
    /// Durably cancel a run and close any active lease.
    Cancel {
        run_id: String,
        /// Test/debug boundary: pause after intent is durable, before facts.
        #[arg(long, hide = true)]
        pause_after_request: bool,
    },
    /// Serve journal protocol v0 over a Unix socket.
    Serve {
        /// Read the trusted host's det-step credential frame from stdin
        /// (docs/proposals/trusted-det-step-credentials-wire.md §1).
        #[arg(long)]
        det_frame_stdin: bool,
        /// Inherited descriptor for the frame's ack or refusal line.
        #[arg(long)]
        det_ack_fd: Option<i32>,
        /// Comma-separated names every deterministic step's env loses. Needs
        /// no frame and no posture (wire §1.1).
        #[arg(long)]
        det_withhold: Option<String>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if matches!(cli.command, Command::ValidateSpec) {
        let verdict = match serde_json::from_reader::<_, serde_json::Value>(std::io::stdin()) {
            Ok(value) => relayflowd::validate_spec::validate_spec(&value),
            Err(error) => relayflowd::validate_spec::refusal(error.to_string()),
        };
        println!("{}", verdict);
        std::process::exit(if verdict["ok"] == true { 0 } else { 2 });
    }
    let engine = Engine::new(&cli.data_dir);
    match cli.command {
        Command::ValidateSpec => unreachable!(),
        Command::Run {
            spec,
            event,
            created_by,
            stop_after,
            pause_before_step,
            pause_before_completion,
        } => {
            if let Some(event) = event {
                let submitted = engine.submit_event(
                    read_spec(&spec)?,
                    serde_json::from_str(&event)?,
                    &created_by,
                )?;
                println!("{}", serde_json::to_string(&submitted)?);
                return Ok(());
            }
            let outcome = engine.start_with_options(
                read_spec(&spec)?,
                &created_by,
                DriveOptions {
                    stop_after,
                    pause_before_step,
                    pause_before_completion,
                    ..DriveOptions::default()
                },
            )?;
            println!("{}", serde_json::to_string(&outcome)?);
            if outcome.status == RunStatus::Failed {
                bail!("run {} failed", outcome.run_id);
            }
        }
        Command::Resume { run_id, stop_after } => {
            let outcome = if stop_after.is_none() {
                if let Some(outcome) = server::resume_via_socket(&cli.data_dir, &run_id)? {
                    outcome
                } else {
                    engine.resume(&run_id, None)?
                }
            } else {
                engine.resume(&run_id, stop_after)?
            };
            println!("{}", serde_json::to_string(&outcome)?);
            if outcome.status == RunStatus::Failed {
                bail!("run {} failed", outcome.run_id);
            }
        }
        Command::Cancel {
            run_id,
            pause_after_request,
        } => {
            let outcome = if !pause_after_request {
                if let Some(outcome) = server::cancel_via_socket(&cli.data_dir, &run_id)? {
                    outcome
                } else {
                    engine.cancel(&run_id, "cli")?
                }
            } else {
                engine.cancel_with_options(
                    &run_id,
                    "cli",
                    CancelOptions {
                        pause_after_request: true,
                    },
                )?
            };
            println!("{}", serde_json::to_string(&outcome)?);
        }
        Command::Serve {
            det_frame_stdin,
            det_ack_fd,
            det_withhold,
        } => {
            let det = relayflowd::det_credentials::bind_from_host(
                det_frame_stdin,
                det_ack_fd,
                det_withhold.as_deref(),
            )
                .unwrap_or_else(|refusal| {
                    eprintln!(
                        "relayflowd: {}",
                        relayflowd::det_credentials::ack::refusal_line(&refusal)
                    );
                    std::process::exit(relayflowd::det_credentials::ack::REFUSED_EXIT);
                });
            server::serve(&cli.data_dir, det)?
        }
    }
    Ok(())
}
