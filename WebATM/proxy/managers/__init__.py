"""Manager modules for the BlueSkyProxy decomposition.

Each manager owns one concern of the proxy: connection lifecycle
(:class:`ConnectionManager`), node/server tracking (:class:`NodeManager`),
command processing (:class:`CommandProcessor`), and data emission/state
(:class:`DataManager`). :class:`~WebATM.proxy.core.BlueSkyProxy` composes
them and delegates.
"""

from .command_processor import CommandProcessor
from .connection_manager import ConnectionManager
from .data_manager import DataManager
from .node_manager import NodeManager

__all__ = [
    "ConnectionManager",
    "NodeManager",
    "CommandProcessor",
    "DataManager",
]
