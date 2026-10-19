#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <sys/ioctl.h>
#include <sys/socket.h>

/* Unread bytes in the kernel buffer of this fd, and that buffer's capacity.
   Child stdio on this runtime is a socket, so F_GETPIPE_SZ does not apply and
   the capacity is SO_RCVBUF. A real pipe uses F_GETPIPE_SZ. Neither value is
   a compile-time constant. */

static int buffer_capacity(int fd) {
  int capacity = fcntl(fd, F_GETPIPE_SZ);
  if (capacity > 0) return capacity;
  int rcv = 0;
  socklen_t len = sizeof(rcv);
  if (getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcv, &len) != 0 || rcv <= 0) return -1;
  return rcv;
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
  int capacity = buffer_capacity(fd);
  if (capacity <= 0) {
    napi_throw_error(env, NULL, "capacity");
    return NULL;
  }
  napi_value obj;
  napi_value unread_value;
  napi_value capacity_value;
  napi_create_object(env, &obj);
  napi_create_int32(env, unread, &unread_value);
  napi_create_int32(env, capacity, &capacity_value);
  napi_set_named_property(env, obj, "unread", unread_value);
  napi_set_named_property(env, obj, "capacity", capacity_value);
  return obj;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "pending", NAPI_AUTO_LENGTH, Pending, NULL, &fn);
  return fn;
}
