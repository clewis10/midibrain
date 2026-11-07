"""Signals must not acquire the lock that runtime pacing may already hold."""
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path


class ShutdownTests(unittest.TestCase):
    def test_rtmidi_input_callbacks_stay_cancelled_during_close(self):
        from unittest.mock import Mock, patch
        from midibrain.performance.runtime import managed_input
        events = []
        class Input:
            __module__ = 'mido.backends.rtmidi'
            closed = False
            _rt = Mock()
            def __enter__(self): return self
            def __exit__(self, *args):
                # The normal backend path must not re-register its callback.
                self.assert_closed()
            def assert_closed(self): assert self.closed
        port = Input()
        port._rt.cancel_callback.side_effect = lambda: events.append('cancel')
        port._rt.close_port.side_effect = lambda: events.append('close')
        port._rt.delete.side_effect = lambda: events.append('delete')
        with patch('midibrain.performance.runtime.time.sleep', side_effect=lambda _: events.append('drain')):
            with self.assertRaisesRegex(ValueError, 'processing failed'):
                with managed_input(port):
                    raise ValueError('processing failed')
        self.assertEqual(events, ['cancel', 'drain', 'close', 'delete'])

    def test_restart_relaunches_module_after_runtime_and_web_shutdown(self):
        script = textwrap.dedent('''
            import sys, time
            from unittest.mock import patch
            from midibrain.performance import cli

            events = []
            class Server:
                started = True
                should_exit = False
                def __init__(self, config): pass
                def run(self):
                    while not self.should_exit: time.sleep(.001)
                    events.append('web stopped')

            def run(session, **kwargs):
                session.demo = False
                session.config_path = 'copied-profile.json'
                session.running = True
                session.restart_process()
                assert session.stop_event.wait(2)
                session.running = False
                events.append('MIDI stopped')

            def execv(executable, args):
                assert events == ['MIDI stopped', 'web stopped'], events
                assert executable == sys.executable
                assert args == [sys.executable, '-m', 'midibrain.performance.cli', 'demo', '--web']
                events.append('relaunched')

            with patch('uvicorn.Server', Server), patch.object(cli, 'run', run), patch.object(cli.os, 'execv', execv):
                cli.main(['demo', '--web'])
            assert events[-1] == 'relaunched'
        ''')
        result = subprocess.run([sys.executable, '-c', script],
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_restart_api_returns_instance_and_schedules_once(self):
        from unittest.mock import patch
        from fastapi.testclient import TestClient
        from midibrain.performance.presets import rig_demo_profile
        from midibrain.performance.runtime import Session
        from midibrain.performance.web import create_app
        session = Session(rig_demo_profile(), demo=True)
        session.running = True
        client = TestClient(create_app(session))
        self.assertEqual(client.post('/api/restart').status_code, 400)
        session.demo = False
        session.config_path = 'copied-profile.json'
        with patch('midibrain.performance.runtime.threading.Timer') as timer:
            first = client.post('/api/restart')
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()['instance_id'], session.snapshot()['instance_id'])
            self.assertEqual(client.post('/api/restart').status_code, 200)
            self.assertEqual(timer.call_count, 1)
            self.assertIs(timer.call_args.args[1].__self__, session)

    def test_interrupt_and_terminate_while_event_lock_is_held(self):
        for signum in ('SIGINT', 'SIGTERM'):
            with self.subTest(signal=signum):
                script = textwrap.dedent('''
                    import signal
                    from unittest.mock import patch
                    from midibrain.performance import cli, runtime

                    def interrupted_run(session, **kwargs):
                        # Deterministically simulate delivery inside Event.wait's
                        # critical section. Event.set in the handler deadlocks.
                        with session.stop_event._cond:
                            signal.raise_signal(getattr(signal, SIGNAL_NAME))
                        assert session.signal_stop_requested
                        assert not session.stop_event.is_set()
                        runtime.run(session, duration=0.1)
                        assert not session.running
                        assert not session.pending

                    with patch.object(cli, 'run', interrupted_run):
                        cli.main(['demo'])
                ''').replace('SIGNAL_NAME', repr(signum))
                result = subprocess.run(
                    [sys.executable, '-c', script],
                    cwd=Path(__file__).resolve().parents[1],
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
