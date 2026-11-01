/*
 * AlphaCode PTY helper (optional native shim, ~200 lines, no dependencies).
 *
 * Gives the web terminal a *real* pseudo-terminal: job control, colours, vim,
 * top, Ctrl-C, SIGWINCH resizing — everything a pipe-based "shell" fakes badly.
 *
 *   ptyhelper <cols> <rows> <sizefile> -- <program> [args...]
 *
 * The size file holds "cols rows"; send SIGUSR1 to apply a resize.
 * Build: cc -O2 -o ptyhelper native/ptyhelper.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <limits.h>

static int master_fd = -1;
static pid_t child_pid = -1;
static char size_path[PATH_MAX];
static volatile sig_atomic_t want_resize = 0;
static volatile sig_atomic_t want_exit = 0;

static void on_usr1(int sig) { (void)sig; want_resize = 1; }
static void on_term(int sig) { (void)sig; want_exit = 1; }

static void apply_size(int fd) {
  FILE *f = fopen(size_path, "r");
  if (!f) return;
  int cols = 0, rows = 0;
  if (fscanf(f, "%d %d", &cols, &rows) == 2 && cols > 0 && rows > 0) {
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_col = (unsigned short)cols;
    ws.ws_row = (unsigned short)rows;
    if (ioctl(fd, TIOCSWINSZ, &ws) == 0 && child_pid > 0) kill(child_pid, SIGWINCH);
  }
  fclose(f);
}

int main(int argc, char **argv) {
  if (argc < 6 || strcmp(argv[4], "--") != 0) {
    fprintf(stderr, "usage: %s <cols> <rows> <sizefile> -- <prog> [args...]\n", argv[0]);
    return 2;
  }
  int cols = atoi(argv[1]);
  int rows = atoi(argv[2]);
  snprintf(size_path, sizeof(size_path), "%s", argv[3]);

  master_fd = posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (master_fd < 0 || grantpt(master_fd) != 0 || unlockpt(master_fd) != 0) {
    perror("posix_openpt");
    return 1;
  }
  const char *slave_name = ptsname(master_fd);
  if (!slave_name) { perror("ptsname"); return 1; }

  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = cols > 0 ? (unsigned short)cols : 120;
  ws.ws_row = rows > 0 ? (unsigned short)rows : 32;
  ioctl(master_fd, TIOCSWINSZ, &ws);

  child_pid = fork();
  if (child_pid < 0) { perror("fork"); return 1; }

  if (child_pid == 0) {
    setsid();
    int slave = open(slave_name, O_RDWR);
    if (slave < 0) _exit(1);
#ifdef TIOCSCTTY
    ioctl(slave, TIOCSCTTY, 0);
#endif
    dup2(slave, STDIN_FILENO);
    dup2(slave, STDOUT_FILENO);
    dup2(slave, STDERR_FILENO);
    if (slave > STDERR_FILENO) close(slave);
    close(master_fd);
    setenv("TERM", "xterm-256color", 1);
    setenv("COLORTERM", "truecolor", 1);
    setenv("ALPHACODE_TERMINAL", "1", 1);
    execvp(argv[5], &argv[5]);
    fprintf(stderr, "alphacode: exec failed: %s\n", strerror(errno));
    _exit(127);
  }

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_usr1;
  sigaction(SIGUSR1, &sa, NULL);
  sa.sa_handler = on_term;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);

  char buf[65536];
  for (;;) {
    if (want_exit) break;
    if (want_resize) { want_resize = 0; apply_size(master_fd); }

    struct pollfd fds[2];
    fds[0].fd = master_fd; fds[0].events = POLLIN; fds[0].revents = 0;
    fds[1].fd = STDIN_FILENO; fds[1].events = POLLIN; fds[1].revents = 0;

    int ready = poll(fds, 2, 500);
    if (ready < 0) { if (errno == EINTR) continue; break; }

    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(master_fd, buf, sizeof(buf));
      if (n > 0) {
        ssize_t off = 0;
        while (off < n) {
          ssize_t w = write(STDOUT_FILENO, buf + off, (size_t)(n - off));
          if (w <= 0) { if (errno == EINTR) continue; goto done; }
          off += w;
        }
      } else if (n == 0) {
        goto done;
      } else if (errno != EAGAIN && errno != EINTR) {
        goto done;
      }
    }

    if (fds[1].revents & POLLIN) {
      ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
      if (n > 0) {
        ssize_t off = 0;
        while (off < n) {
          ssize_t w = write(master_fd, buf + off, (size_t)(n - off));
          if (w <= 0) { if (errno == EINTR) continue; break; }
          off += w;
        }
      } else if (n == 0) {
        /* stdin closed → keep the pty alive until the child exits */
        fds[1].fd = -1;
        break;
      }
    }
  }

done:
  if (child_pid > 0) {
    kill(child_pid, SIGHUP);
    int status = 0;
    for (int i = 0; i < 40; i++) {
      pid_t r = waitpid(child_pid, &status, WNOHANG);
      if (r == child_pid) break;
      usleep(25000);
    }
    kill(child_pid, SIGKILL);
  }
  if (master_fd >= 0) close(master_fd);
  return 0;
}
