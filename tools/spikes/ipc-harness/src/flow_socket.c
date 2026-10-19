#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <linux/seccomp.h>
#include <node_api.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* Child stdio ends for the flow-control reservation.
   socketpair, SO_SNDBUF on each writer, a dup of the stdin read end for
   FIONREAD, and shutdown of the unused direction. SIOCOUTQ is not read:
   on AF_UNIX it counts skb truesize, not payload bytes. */

static void close_quiet(int fd) {
  if (fd >= 0) close(fd);
}

static void close_all(int in0, int in1, int out0, int out1, int probe, int writer) {
  close_quiet(in0);
  close_quiet(in1);
  close_quiet(out0);
  close_quiet(out1);
  close_quiet(probe);
  close_quiet(writer);
}

static int read_sockopt(int fd, int opt, int *got) {
  int value = 0;
  socklen_t len = sizeof(value);
  if (getsockopt(fd, SOL_SOCKET, opt, &value, &len) != 0 || value <= 0) return -1;
  *got = value;
  return 0;
}

static int set_sockopt(int fd, int opt, int request, int *got) {
  if (setsockopt(fd, SOL_SOCKET, opt, &request, sizeof(request)) != 0) return -1;
  return read_sockopt(fd, opt, got);
}

static int read_sndbuf(int fd, int *got) {
  return read_sockopt(fd, SO_SNDBUF, got);
}

static int set_sndbuf(int fd, int request, int *got) {
  return set_sockopt(fd, SO_SNDBUF, request, got);
}

static napi_value int_prop(napi_env env, napi_value obj, const char *name, int value) {
  napi_value out;
  if (napi_create_int32(env, value, &out) != napi_ok) return NULL;
  if (napi_set_named_property(env, obj, name, out) != napi_ok) return NULL;
  return obj;
}

static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t request = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &request) != napi_ok || request <= 0) {
    napi_throw_type_error(env, NULL, "sndbuf");
    return NULL;
  }
  int in[2] = {-1, -1};
  int out[2] = {-1, -1};
  int probe = -1;
  int writer = -1;
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, in) != 0) {
    napi_throw_error(env, NULL, "socketpair");
    return NULL;
  }
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, out) != 0) {
    close_all(in[0], in[1], -1, -1, -1, -1);
    napi_throw_error(env, NULL, "socketpair");
    return NULL;
  }
  /* in[0] is the parent's stdin writer. out[0] is the child's stdout writer. */
  int sndbuf_out = 0;
  int sndbuf_in = 0;
  if (set_sndbuf(in[0], request, &sndbuf_out) != 0 || set_sndbuf(out[0], request, &sndbuf_in) != 0) {
    close_all(in[0], in[1], out[0], out[1], -1, -1);
    napi_throw_error(env, NULL, "sndbuf");
    return NULL;
  }
  probe = dup(in[1]);
  writer = dup(out[0]);
  if (probe < 0 || writer < 0
      || fcntl(probe, F_SETFD, FD_CLOEXEC) != 0
      || fcntl(writer, F_SETFD, FD_CLOEXEC) != 0) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "dup");
    return NULL;
  }
  /* The child inherits in[1] as fd 0 and out[0] as fd 1. Shut the directions
     it must not use. shutdown is not reversible. The writer dup shares that
     socket, so a later SO_SNDBUF on the child's fd is visible here. */
  if (shutdown(in[1], SHUT_WR) != 0 || shutdown(out[0], SHUT_RD) != 0) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "shutdown");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  if (!int_prop(env, obj, "parentStdin", in[0])
      || !int_prop(env, obj, "childStdin", in[1])
      || !int_prop(env, obj, "stdinProbe", probe)
      || !int_prop(env, obj, "stdoutWriter", writer)
      || !int_prop(env, obj, "childStdout", out[0])
      || !int_prop(env, obj, "parentStdout", out[1])
      || !int_prop(env, obj, "sndbufIn", sndbuf_in)
      || !int_prop(env, obj, "sndbufOut", sndbuf_out)) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  return obj;
}

static napi_value Pending(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  int unread = 0;
  if (ioctl(fd, FIONREAD, &unread) != 0 || unread < 0) {
    napi_throw_error(env, NULL, "ioctl");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, unread, &out) != napi_ok) return NULL;
  return out;
}

static napi_value SetSndbuf(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  int32_t request = 0;
  if (argc < 2
      || napi_get_value_int32(env, argv[0], &fd) != napi_ok
      || napi_get_value_int32(env, argv[1], &request) != napi_ok
      || fd < 0
      || request <= 0) {
    napi_throw_type_error(env, NULL, "sndbuf");
    return NULL;
  }
  int got = 0;
  if (set_sndbuf(fd, request, &got) != 0) {
    napi_throw_error(env, NULL, "sndbuf");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, got, &out) != napi_ok) return NULL;
  return out;
}

static napi_value GetSndbuf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  int got = 0;
  if (read_sndbuf(fd, &got) != 0) {
    napi_throw_error(env, NULL, "sndbuf");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, got, &out) != napi_ok) return NULL;
  return out;
}

static napi_value GetRcvbuf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  int got = 0;
  if (read_sockopt(fd, SO_RCVBUF, &got) != 0) {
    napi_throw_error(env, NULL, "rcvbuf");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, got, &out) != napi_ok) return NULL;
  return out;
}

static napi_value one_fd(napi_env env, napi_callback_info info, int32_t *fd) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_int32(env, argv[0], fd) != napi_ok) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  napi_value undef;
  if (napi_get_undefined(env, &undef) != napi_ok) return NULL;
  return undef;
}

/* Listening socket with SO_SNDBUF and SO_RCVBUF pinned before listen.
   The caller listens. The accepted socket inherits this read-back. */
static napi_value PinListen(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t request = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &request) != napi_ok || request <= 0) {
    napi_throw_type_error(env, NULL, "sndbuf");
    return NULL;
  }
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    napi_throw_error(env, NULL, "socket");
    return NULL;
  }
  int snd = 0;
  int rcv = 0;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(0);
  if (set_sockopt(fd, SO_SNDBUF, request, &snd) != 0
      || set_sockopt(fd, SO_RCVBUF, request, &rcv) != 0
      || bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "pin");
    return NULL;
  }
  struct sockaddr_in bound;
  socklen_t blen = sizeof(bound);
  if (getsockname(fd, (struct sockaddr *)&bound, &blen) != 0) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "pin");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  if (!int_prop(env, obj, "fd", fd)
      || !int_prop(env, obj, "port", ntohs(bound.sin_port))
      || !int_prop(env, obj, "sndbuf", snd)
      || !int_prop(env, obj, "rcvbuf", rcv)) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  return obj;
}

/* Connected socket. Buffers are set before connect, then read back. */
static napi_value ConnectPinned(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t port = 0;
  int32_t request = 0;
  if (argc < 2
      || napi_get_value_int32(env, argv[0], &port) != napi_ok
      || napi_get_value_int32(env, argv[1], &request) != napi_ok
      || port <= 0
      || request <= 0) {
    napi_throw_type_error(env, NULL, "connect");
    return NULL;
  }
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    napi_throw_error(env, NULL, "socket");
    return NULL;
  }
  int snd = 0;
  int rcv = 0;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons((uint16_t)port);
  if (set_sockopt(fd, SO_SNDBUF, request, &snd) != 0
      || set_sockopt(fd, SO_RCVBUF, request, &rcv) != 0
      || connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "connect");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  if (!int_prop(env, obj, "fd", fd)
      || !int_prop(env, obj, "sndbuf", snd)
      || !int_prop(env, obj, "rcvbuf", rcv)) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  return obj;
}

static napi_value DupFd(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  if (!one_fd(env, info, &fd) || fd < 0) return NULL;
  int duped = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  if (duped < 0) {
    napi_throw_error(env, NULL, "dup");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, duped, &out) != napi_ok) return NULL;
  return out;
}

static napi_value SetSubreaper(napi_env env, napi_callback_info info) {
  (void)info;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    napi_throw_error(env, NULL, "subreaper");
    return NULL;
  }
  napi_value undef;
  if (napi_get_undefined(env, &undef) != napi_ok) return NULL;
  return undef;
}

static napi_value SetGroup(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = -1;
  int32_t pgid = -1;
  if (argc < 2
      || napi_get_value_int32(env, argv[0], &pid) != napi_ok
      || napi_get_value_int32(env, argv[1], &pgid) != napi_ok
      || pid < 0
      || pgid <= 1) {
    napi_throw_type_error(env, NULL, "setpgid");
    return NULL;
  }
  if (setpgid(pid, pgid) != 0) {
    napi_throw_error(env, NULL, "setpgid");
    return NULL;
  }
  napi_value undef;
  if (napi_get_undefined(env, &undef) != napi_ok) return NULL;
  return undef;
}

static napi_value ProcessGroup(napi_env env, napi_callback_info info) {
  int32_t pid = -1;
  if (!one_fd(env, info, &pid) || pid < 0) return NULL;
  pid_t group = getpgid(pid);
  if (group <= 1) {
    napi_throw_error(env, NULL, "getpgid");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, (int32_t)group, &out) != napi_ok) return NULL;
  return out;
}

/* Fork is allowed here: the caller is the supervisor, not a confined plugin.
   The child joins pgid and sleeps. It must not touch the runtime after fork. */
static napi_value SpawnSleeper(napi_env env, napi_callback_info info) {
  int32_t pgid = 0;
  if (!one_fd(env, info, &pgid) || pgid <= 1) return NULL;
  pid_t pid = fork();
  if (pid < 0) {
    napi_throw_error(env, NULL, "fork");
    return NULL;
  }
  if (pid == 0) {
    if (setpgid(0, pgid) != 0) _exit(2);
    for (;;) pause();
  }
  napi_value out;
  if (napi_create_int32(env, (int32_t)pid, &out) != napi_ok) return NULL;
  return out;
}

static napi_value ReapGroup(napi_env env, napi_callback_info info) {
  int32_t pgid = 0;
  if (!one_fd(env, info, &pgid) || pgid <= 1) return NULL;
  int reaped = 0;
  for (;;) {
    int status = 0;
    pid_t got = waitpid(-(pid_t)pgid, &status, WNOHANG);
    if (got > 0) {
      reaped++;
      continue;
    }
    break;
  }
  napi_value out;
  if (napi_create_int32(env, reaped, &out) != napi_ok) return NULL;
  return out;
}

/* Errno of one forbidden call. A success is confinement failure: the child
   of an unexpected fork exits, and the parent reports 0. Refuses to try
   unless this process already has the filter, so a test process cannot fork. */
struct clone_args_min {
  uint64_t flags;
  uint64_t pidfd;
  uint64_t child_tid;
  uint64_t parent_tid;
  uint64_t exit_signal;
  uint64_t stack;
  uint64_t stack_size;
  uint64_t tls;
};

static int call_errno(long nr, long a0, long a1) {
  errno = 0;
  long rc = syscall(nr, a0, a1, 0, 0, 0, 0);
  if (rc < 0) return errno;
  if (rc == 0) _exit(0);
  return 0;
}

static napi_value ProbeConfinement(napi_env env, napi_callback_info info) {
  (void)info;
  int nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  int mode = prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
  if (nnp != 1 || mode != SECCOMP_MODE_FILTER) {
    napi_throw_error(env, NULL, "not-confined");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  if (!int_prop(env, obj, "confined", 1)) return NULL;
#ifdef __NR_fork
  if (!int_prop(env, obj, "fork", call_errno(__NR_fork, 0, 0))) return NULL;
#endif
#ifdef __NR_vfork
  if (!int_prop(env, obj, "vfork", call_errno(__NR_vfork, 0, 0))) return NULL;
#endif
#ifdef __NR_clone
  if (!int_prop(env, obj, "clone", call_errno(__NR_clone, 0, 0))) return NULL;
#endif
#ifdef __NR_clone3
  struct clone_args_min args;
  memset(&args, 0, sizeof(args));
  args.exit_signal = SIGCHLD;
  if (!int_prop(env, obj, "clone3", call_errno(__NR_clone3, (long)&args, (long)sizeof(args)))) return NULL;
#endif
#ifdef __NR_splice
  if (!int_prop(env, obj, "splice", call_errno(__NR_splice, -1, -1))) return NULL;
#endif
#ifdef __NR_sendfile
  if (!int_prop(env, obj, "sendfile", call_errno(__NR_sendfile, -1, -1))) return NULL;
#endif
#ifdef __NR_io_uring_setup
  if (!int_prop(env, obj, "io_uring_setup", call_errno(__NR_io_uring_setup, 1, 0))) return NULL;
#endif
  return obj;
}

static void export_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

NAPI_MODULE_INIT() {
  export_fn(env, exports, "create", Create);
  export_fn(env, exports, "pending", Pending);
  export_fn(env, exports, "setSndbuf", SetSndbuf);
  export_fn(env, exports, "sndbuf", GetSndbuf);
  export_fn(env, exports, "rcvbuf", GetRcvbuf);
  export_fn(env, exports, "pinListen", PinListen);
  export_fn(env, exports, "connectPinned", ConnectPinned);
  export_fn(env, exports, "dupFd", DupFd);
  export_fn(env, exports, "setSubreaper", SetSubreaper);
  export_fn(env, exports, "setGroup", SetGroup);
  export_fn(env, exports, "processGroup", ProcessGroup);
  export_fn(env, exports, "reapGroup", ReapGroup);
  export_fn(env, exports, "spawnSleeper", SpawnSleeper);
  export_fn(env, exports, "probeConfinement", ProbeConfinement);
  return exports;
}
