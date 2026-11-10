#include "ui_port.h"

#ifdef LVGLUI_HOST
/* 随着 ui_port.h 增加接口，在这里给 host 预览提供空实现（固件里这个 TU 是空的，
   真正的实现由 components\/ui_port 提供）。 */
#endif
